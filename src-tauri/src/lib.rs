use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    job_id: String,
    progress: f64,
    status: String,
    title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadResult {
    title: String,
    path: String,
    duration_seconds: f64,
    bitrate_kbps: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaFile {
    path: String,
    title: String,
    modified_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformResult {
    samples: Vec<f32>,
    duration_seconds: f64,
    bpm: Option<u16>,
    musical_key: Option<String>,
}

#[derive(Deserialize)]
struct SpotifyEmbed {
    title: String,
}

fn emit_progress(
    app: &AppHandle,
    job_id: &str,
    progress: f64,
    status: &str,
    title: Option<String>,
) {
    let _ = app.emit(
        "download-progress",
        ProgressEvent {
            job_id: job_id.into(),
            progress,
            status: status.into(),
            title,
        },
    );
}

fn expand_output_dir(raw: &str) -> Result<PathBuf, String> {
    let expanded = if raw == "~" || raw.starts_with("~/") {
        let home =
            std::env::var("HOME").map_err(|_| "Could not locate your home folder".to_string())?;
        PathBuf::from(home).join(raw.trim_start_matches("~/"))
    } else {
        PathBuf::from(raw)
    };
    std::fs::create_dir_all(&expanded)
        .map_err(|error| format!("Could not create the output folder: {error}"))?;
    Ok(expanded)
}

fn resolve_tool(name: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if name == "yt-dlp" {
        if let Ok(home) = std::env::var("HOME") {
            candidates
                .push(PathBuf::from(home).join("Library/Application Support/Redliner/yt-dlp"));
        }
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
        PathBuf::from("/usr/bin").join(name),
    ]);
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|directory| directory.join(name)));
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            format!("{name} is required. Install it with Homebrew, then reopen Redliner.")
        })
}

async fn spotify_search(url: &str) -> Result<String, String> {
    let mut endpoint = reqwest::Url::parse("https://open.spotify.com/oembed")
        .map_err(|error| error.to_string())?;
    endpoint.query_pairs_mut().append_pair("url", url);
    let embed = reqwest::get(endpoint)
        .await
        .map_err(|error| format!("Could not read the Spotify link: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Spotify rejected the link: {error}"))?
        .json::<SpotifyEmbed>()
        .await
        .map_err(|error| format!("Could not identify the Spotify track: {error}"))?;
    Ok(format!("ytsearch1:{} audio", embed.title))
}

fn parse_percent(line: &str) -> Option<f64> {
    let marker = line.find('%')?;
    let before = &line[..marker];
    let token = before.split_whitespace().last()?;
    token.parse::<f64>().ok()
}

fn downloader_command(downloader: PathBuf, ffmpeg: PathBuf) -> Result<Command, String> {
    let managed_downloader = downloader
        .to_string_lossy()
        .contains("Library/Application Support/Redliner/yt-dlp");
    let ffmpeg_location = ffmpeg
        .parent()
        .ok_or("Could not locate the ffmpeg tools folder")?;
    let mut command = Command::new(downloader);
    command.args(["--newline", "--no-playlist"]);
    if managed_downloader {
        command.args(["--impersonate", "Safari-26.0:Ios-26.0"]);
    }
    command.arg("--ffmpeg-location").arg(ffmpeg_location);
    Ok(command)
}

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" | "aif" | "aiff"
            )
        })
}

fn media_file(path: &Path) -> Result<MediaFile, String> {
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled track")
        .to_string();
    Ok(MediaFile {
        path: path.to_string_lossy().into_owned(),
        title,
        modified_ms,
    })
}

fn validated_media_path(path: &str, folder: &str) -> Result<PathBuf, String> {
    let root = expand_output_dir(folder)?
        .canonicalize()
        .map_err(|error| format!("Could not read the selected folder: {error}"))?;
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "The track no longer exists".to_string())?;
    if !target.starts_with(&root) || !target.is_file() || !is_audio_file(&target) {
        return Err("Redliner can only change audio files inside the selected folder".into());
    }
    Ok(target)
}

fn valid_track_name(value: &str) -> Result<&str, String> {
    let name = value.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err("Enter a file name without folders or hidden-file prefixes".into());
    }
    Ok(name)
}

fn summarize_pcm(bytes: &[u8], bucket_count: usize) -> (Vec<f32>, f64) {
    let sample_count = bytes.len() / 2;
    if sample_count == 0 || bucket_count == 0 {
        return (vec![0.04; bucket_count], 0.0);
    }
    let bucket_width = sample_count.div_ceil(bucket_count);
    let mut peaks = Vec::with_capacity(bucket_count);
    for bucket in 0..bucket_count {
        let start = bucket * bucket_width;
        let end = ((bucket + 1) * bucket_width).min(sample_count);
        let mut peak = 0u16;
        for index in start..end {
            let offset = index * 2;
            let value = i16::from_le_bytes([bytes[offset], bytes[offset + 1]]).unsigned_abs();
            peak = peak.max(value);
        }
        peaks.push(peak as f32);
    }
    let max_peak = peaks.iter().copied().fold(0.0_f32, f32::max);
    let samples = peaks
        .into_iter()
        .map(|peak| {
            if max_peak > 0.0 {
                (peak / max_peak).powf(0.55).max(0.04)
            } else {
                0.04
            }
        })
        .collect();
    (samples, sample_count as f64 / 1000.0)
}

fn pcm_samples(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / i16::MAX as f32)
        .collect()
}

fn estimate_bpm(samples: &[f32], sample_rate: usize) -> Option<u16> {
    let frame_size = (sample_rate / 50).max(1);
    let energy: Vec<f32> = samples
        .chunks(frame_size)
        .map(|frame| frame.iter().map(|sample| sample.abs()).sum::<f32>() / frame.len() as f32)
        .collect();
    if energy.len() < 120 {
        return None;
    }
    let mut onset = vec![0.0; energy.len()];
    for index in 8..energy.len() {
        let baseline = energy[index - 8..index].iter().sum::<f32>() / 8.0;
        onset[index] = (energy[index] - baseline).max(0.0);
    }
    let frame_ms = frame_size as f32 * 1000.0 / sample_rate as f32;
    let mut best = (0.0_f32, 0_usize);
    let minimum_lag = (60_000.0 / (180.0 * frame_ms)).round() as usize;
    let maximum_lag = (60_000.0 / (70.0 * frame_ms)).round() as usize;
    for lag in minimum_lag..=maximum_lag.min(onset.len() - 1) {
        let mut cross = 0.0;
        let mut left = 0.0;
        let mut right = 0.0;
        for index in lag..onset.len() {
            cross += onset[index] * onset[index - lag];
            left += onset[index] * onset[index];
            right += onset[index - lag] * onset[index - lag];
        }
        let score = cross / (left * right).sqrt().max(f32::EPSILON);
        if score > best.0 {
            best = (score, lag);
        }
    }
    (best.0 >= 0.08).then(|| (60_000.0 / (best.1 as f32 * frame_ms)).round() as u16)
}

fn estimate_key(samples: &[f32], sample_rate: usize) -> Option<String> {
    const MAJOR: [f32; 12] = [
        6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ];
    const MINOR: [f32; 12] = [
        6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
    ];
    const NAMES: [&str; 12] = [
        "C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B",
    ];
    if samples.len() < sample_rate * 4 {
        return None;
    }
    let frame_len = 2048.min(samples.len());
    let possible_frames = samples.len().saturating_sub(frame_len) / frame_len + 1;
    let frame_count = possible_frames.min(64);
    let stride = (possible_frames / frame_count).max(1) * frame_len;
    let window: Vec<f32> = (0..frame_len)
        .map(|index| {
            0.5 - 0.5 * (std::f32::consts::TAU * index as f32 / (frame_len - 1) as f32).cos()
        })
        .collect();
    let mut chroma = [0.0_f32; 12];
    for frame_index in 0..frame_count {
        let start = (frame_index * stride).min(samples.len() - frame_len);
        let frame = &samples[start..start + frame_len];
        let rms =
            (frame.iter().map(|sample| sample * sample).sum::<f32>() / frame_len as f32).sqrt();
        if rms < 0.004 {
            continue;
        }
        for midi in 36..=71 {
            let frequency = 440.0 * 2.0_f32.powf((midi as f32 - 69.0) / 12.0);
            let coefficient = 2.0 * (std::f32::consts::TAU * frequency / sample_rate as f32).cos();
            let mut previous = 0.0_f32;
            let mut previous_two = 0.0_f32;
            for (sample, weight) in frame.iter().zip(&window) {
                let current = sample * weight + coefficient * previous - previous_two;
                previous_two = previous;
                previous = current;
            }
            let power = (previous_two * previous_two + previous * previous
                - coefficient * previous * previous_two)
                .max(0.0)
                .sqrt();
            chroma[midi % 12] += power / frequency.sqrt();
        }
    }
    let chroma_total = chroma.iter().sum::<f32>();
    if chroma_total <= f32::EPSILON {
        return None;
    }
    let mut best_score = f32::NEG_INFINITY;
    let mut best_key = String::new();
    for tonic in 0..12 {
        for (profile, minor) in [(&MAJOR, false), (&MINOR, true)] {
            let score = profile
                .iter()
                .enumerate()
                .map(|(offset, weight)| chroma[(tonic + offset) % 12] * weight)
                .sum::<f32>();
            if score > best_score {
                best_score = score;
                best_key = format!("{}{}", NAMES[tonic], if minor { "m" } else { "" });
            }
        }
    }
    Some(best_key)
}

async fn read_dj_tags(path: &Path) -> (Option<u16>, Option<String>) {
    let Ok(tool) = resolve_tool("ffprobe") else {
        return (None, None);
    };
    let Ok(output) = Command::new(tool)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format_tags=TBPM,BPM,INITIALKEY,TKEY,KEY",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .await
    else {
        return (None, None);
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return (None, None);
    };
    let Some(tags) = value["format"]["tags"].as_object() else {
        return (None, None);
    };
    let tag = |names: &[&str]| {
        tags.iter().find_map(|(key, value)| {
            names
                .iter()
                .any(|name| key.eq_ignore_ascii_case(name))
                .then(|| value.as_str())
                .flatten()
        })
    };
    let bpm = tag(&["TBPM", "BPM"])
        .and_then(|value| value.parse::<f32>().ok())
        .map(|value| value.round().clamp(1.0, u16::MAX as f32) as u16);
    let musical_key = tag(&["INITIALKEY", "TKEY", "KEY"])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    (bpm, musical_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_downloader_progress() {
        assert_eq!(parse_percent("[download]  62.3% of 4.2MiB"), Some(62.3));
        assert_eq!(parse_percent("[ExtractAudio] Destination: track.mp3"), None);
    }

    #[test]
    fn gives_downloader_the_resolved_ffmpeg_folder() {
        let command = downloader_command(
            PathBuf::from("/Applications/Redliner/yt-dlp"),
            PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        )
        .unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--ffmpeg-location", "/opt/homebrew/bin"]));
    }

    #[test]
    fn summarizes_pcm_into_fixed_waveform() {
        let bytes: Vec<u8> = [0i16, 1000, -2000, 500]
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect();
        let (samples, duration) = summarize_pcm(&bytes, 2);
        assert_eq!(samples.len(), 2);
        assert!((duration - 0.004).abs() < f64::EPSILON);
        assert!(samples[0] < samples[1]);
    }

    #[test]
    fn estimates_tempo_from_regular_pulses() {
        let mut samples = vec![0.0_f32; 20_000];
        for beat in (0..samples.len()).step_by(500) {
            for sample in &mut samples[beat..(beat + 20).min(20_000)] {
                *sample = 1.0;
            }
        }
        assert_eq!(estimate_bpm(&samples, 1000), Some(120));
    }

    #[test]
    fn estimates_c_major_from_a_triad() {
        let samples: Vec<f32> = (0..8_000)
            .map(|index| {
                let time = index as f32 / 1000.0;
                [261.63_f32, 329.63, 392.0]
                    .into_iter()
                    .map(|frequency| (std::f32::consts::TAU * frequency * time).sin())
                    .sum::<f32>()
                    / 3.0
            })
            .collect();
        assert_eq!(estimate_key(&samples, 1000).as_deref(), Some("C"));
    }

    #[test]
    fn rejects_unsafe_track_names() {
        assert!(valid_track_name("clean title").is_ok());
        assert!(valid_track_name("../outside").is_err());
        assert!(valid_track_name("folder/title").is_err());
        assert!(valid_track_name(".hidden").is_err());
    }

    #[test]
    fn renames_only_inside_the_selected_folder() {
        let library = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = library.path().join("before.mp3");
        let outside_track = outside.path().join("outside.mp3");
        std::fs::write(&source, b"test").unwrap();
        std::fs::write(&outside_track, b"test").unwrap();

        let renamed = rename_media_file(
            source.to_string_lossy().into_owned(),
            library.path().to_string_lossy().into_owned(),
            "after".into(),
        )
        .unwrap();
        assert!(renamed.path.ends_with("after.mp3"));
        assert!(Path::new(&renamed.path).is_file());
        assert!(validated_media_path(
            &outside_track.to_string_lossy(),
            &library.path().to_string_lossy()
        )
        .is_err());
    }

    #[test]
    fn opens_only_known_project_links() {
        assert!(allowed_external_url("https://shivvtrivedi.com"));
        assert!(allowed_external_url(
            "https://buymeacoffee.com/shivvtrivedi"
        ));
        assert!(!allowed_external_url("https://example.com"));
    }

    #[test]
    fn imports_audio_without_overwriting_existing_tracks() {
        let library = tempfile::tempdir().unwrap();
        let first = write_imported_media(
            "request.mp3",
            b"audio",
            library.path().to_string_lossy().into_owned(),
        )
        .unwrap();
        let second = write_imported_media(
            "request.mp3",
            b"audio",
            library.path().to_string_lossy().into_owned(),
        )
        .unwrap();

        assert!(first.path.ends_with("request.mp3"));
        assert!(second.path.ends_with("request (2).mp3"));
        assert_eq!(std::fs::read(&second.path).unwrap(), b"audio");
    }
}

async fn analyze(path: &Path) -> Result<(f64, u64), String> {
    let output = Command::new(resolve_tool("ffprobe")?)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration,bit_rate",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .await
        .map_err(|error| format!("ffprobe is required: {error}"))?;
    if !output.status.success() {
        return Err("The downloaded file could not be analyzed".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let format = &value["format"];
    let duration = format["duration"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);
    let bitrate = format["bit_rate"]
        .as_str()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
        / 1000;
    Ok((duration, bitrate))
}

#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.get_text())
        .map_err(|error| format!("Could not read the clipboard: {error}"))
}

#[tauri::command]
fn scan_media_folder(folder: String) -> Result<Vec<MediaFile>, String> {
    let root = expand_output_dir(&folder)?;
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry.file_type().is_file() || !is_audio_file(path) {
            continue;
        }
        files.push(media_file(path)?);
    }
    files.sort_by(|left, right| {
        right
            .modified_ms
            .cmp(&left.modified_ms)
            .then_with(|| left.title.cmp(&right.title))
    });
    Ok(files)
}

#[tauri::command]
fn rename_media_file(path: String, folder: String, new_name: String) -> Result<MediaFile, String> {
    let source = validated_media_path(&path, &folder)?;
    let name = valid_track_name(&new_name)?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("The track has no file extension")?;
    let destination = source.with_file_name(format!("{name}.{extension}"));
    if destination != source && destination.exists() {
        return Err("A track with that name already exists".into());
    }
    std::fs::rename(&source, &destination)
        .map_err(|error| format!("Could not rename the track: {error}"))?;
    media_file(&destination)
}

#[tauri::command]
fn trash_media_files(paths: Vec<String>, folder: String) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    let targets = paths
        .iter()
        .map(|path| validated_media_path(path, &folder))
        .collect::<Result<Vec<_>, _>>()?;
    let count = targets.len();
    trash::delete_all(targets)
        .map_err(|error| format!("Could not move the tracks to Trash: {error}"))?;
    Ok(count)
}

#[tauri::command]
fn reveal_media_file(path: String, folder: String) -> Result<(), String> {
    let target = validated_media_path(&path, &folder)?;
    std::process::Command::new("open")
        .arg("-R")
        .arg(target)
        .status()
        .map_err(|error| format!("Could not open Finder: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "Finder could not reveal this track".to_string())
}

fn available_import_path(root: &Path, source: &Path) -> Result<PathBuf, String> {
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("The dropped track has no file name")?;
    let first = root.join(file_name);
    if !first.exists() {
        return Ok(first);
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The dropped track has no file name")?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("The dropped track has no file extension")?;
    for copy in 2..10_000 {
        let candidate = root.join(format!("{stem} ({copy}).{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not find an available file name for the dropped track".into())
}

fn write_imported_media(name: &str, bytes: &[u8], output_dir: String) -> Result<MediaFile, String> {
    if bytes.is_empty() {
        return Err("The dropped track is empty".into());
    }
    let name = valid_track_name(name)?;
    let source = PathBuf::from(name);
    if !is_audio_file(&source) {
        return Err("Drop a supported audio file to import it".into());
    }
    let root = expand_output_dir(&output_dir)?
        .canonicalize()
        .map_err(|error| format!("Could not read the selected folder: {error}"))?;
    let destination = available_import_path(&root, &source)?;
    std::fs::write(&destination, bytes)
        .map_err(|error| format!("Could not import the track: {error}"))?;
    media_file(&destination)
}

fn decoded_request_header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let encoded = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("Missing {name} header"))?
        .to_str()
        .map_err(|_| format!("Invalid {name} header"))?;
    percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map(String::from)
        .map_err(|_| format!("Invalid {name} header"))
}

#[tauri::command]
fn import_media_bytes(request: tauri::ipc::Request<'_>) -> Result<MediaFile, String> {
    let name = decoded_request_header(&request, "x-redliner-file-name")?;
    let output_dir = decoded_request_header(&request, "x-redliner-output-dir")?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("The dropped track did not contain file data".into()),
    };
    write_imported_media(&name, bytes, output_dir)
}

fn allowed_external_url(url: &str) -> bool {
    matches!(
        url,
        "https://shivvtrivedi.com" | "https://buymeacoffee.com/shivvtrivedi"
    )
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !allowed_external_url(&url) {
        return Err("Redliner blocked an unknown external link".into());
    }
    std::process::Command::new("open")
        .arg(url)
        .status()
        .map_err(|error| format!("Could not open the link: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "The link could not be opened".to_string())
}

#[tauri::command]
async fn get_waveform(path: String) -> Result<WaveformResult, String> {
    let file = PathBuf::from(path);
    if !file.is_file() || !is_audio_file(&file) {
        return Err("The track is not a supported audio file".into());
    }
    let tags = read_dj_tags(&file).await;
    let output = Command::new(resolve_tool("ffmpeg")?)
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(&file)
        .args(["-vn", "-ac", "1", "-ar", "1000", "-f", "s16le", "pipe:1"])
        .output()
        .await
        .map_err(|error| format!("Could not analyze the waveform: {error}"))?;
    if !output.status.success() {
        return Err("Could not read this track's waveform".into());
    }
    let decoded = pcm_samples(&output.stdout);
    let (samples, duration_seconds) = summarize_pcm(&output.stdout, 72);
    Ok(WaveformResult {
        samples,
        duration_seconds,
        bpm: tags.0.or_else(|| estimate_bpm(&decoded, 1000)),
        musical_key: tags.1.or_else(|| estimate_key(&decoded, 1000)),
    })
}

#[tauri::command]
async fn download_media(
    app: AppHandle,
    url: String,
    output_dir: String,
    job_id: String,
) -> Result<DownloadResult, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links are supported".into());
    }
    let destination = expand_output_dir(&output_dir)?;
    let input = if url.contains("open.spotify.com/") {
        spotify_search(&url).await?
    } else {
        url
    };

    emit_progress(&app, &job_id, 1.0, "downloading", None);
    let downloader = resolve_tool("yt-dlp")?;
    let mut command = downloader_command(downloader, resolve_tool("ffmpeg")?)?;
    let mut child = command
        .args([
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "0",
            "--embed-metadata",
            "--embed-thumbnail",
            "--convert-thumbnails",
            "jpg",
            "--print",
            "after_move:%(filepath)s",
            "-o",
        ])
        .arg(destination.join("%(artist,uploader)s - %(title)s.%(ext)s"))
        .arg(&input)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("yt-dlp is required: {error}"))?;

    let stderr = child
        .stderr
        .take()
        .ok_or("Could not read downloader progress")?;
    let app_for_progress = app.clone();
    let id_for_progress = job_id.clone();
    let progress_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut last_error = None;
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(percent) = parse_percent(&line) {
                emit_progress(
                    &app_for_progress,
                    &id_for_progress,
                    percent.min(97.0),
                    "downloading",
                    None,
                );
            }
            if let Some(message) = line.split("ERROR:").nth(1) {
                last_error = Some(message.trim().to_string());
            }
        }
        last_error
    });
    let stdout = child
        .stdout
        .take()
        .ok_or("Could not read downloader output")?;
    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut final_path = None;
    while let Some(line) = stdout_lines
        .next_line()
        .await
        .map_err(|error| error.to_string())?
    {
        if !line.trim().is_empty() {
            final_path = Some(PathBuf::from(line.trim()));
        }
    }
    let status = child.wait().await.map_err(|error| error.to_string())?;
    let download_error = progress_task.await.ok().flatten();
    if !status.success() {
        return Err(download_error
            .unwrap_or_else(|| "Download failed. Check the link and your connection.".into()));
    }
    let path = final_path.ok_or("The downloader did not return a file")?;
    emit_progress(&app, &job_id, 98.0, "analyzing", None);
    let (duration, bitrate) = analyze(&path).await?;
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Downloaded track")
        .to_string();
    emit_progress(&app, &job_id, 100.0, "complete", Some(title.clone()));
    Ok(DownloadResult {
        title,
        path: path.to_string_lossy().into_owned(),
        duration_seconds: duration,
        bitrate_kbps: bitrate,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            download_media,
            read_clipboard,
            scan_media_folder,
            get_waveform,
            rename_media_file,
            trash_media_files,
            reveal_media_file,
            import_media_bytes,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running Redliner");
}
