export function detectSource(value: string): string {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    if (host.includes("spotify")) return "Spotify";
    if (host.includes("youtu")) return "YouTube";
    if (host.includes("soundcloud")) return "SoundCloud";
    return host.split(".")[0].replace(/^./, (letter) => letter.toUpperCase());
  } catch {
    return "Link";
  }
}

export function isSupportedUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function extractDroppedUrls(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && isSupportedUrl(line));
}

export function defaultMusicFolder(): string {
  return "~/Music/Redliner";
}

export function filterMediaFiles(files: MediaFile[], query: string): MediaFile[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return files;
  return files.filter((file) => {
    const title = file.title.toLocaleLowerCase();
    return terms.every((term) => title.includes(term));
  });
}

export function sortMediaFiles(
  files: MediaFile[],
  analyses: Record<string, WaveformResult>,
  sort: LibrarySort,
  direction: SortDirection,
): MediaFile[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...files].sort((left, right) => {
    if (sort === "latest") {
      return (left.modifiedMs - right.modifiedMs) * multiplier || left.title.localeCompare(right.title);
    }
    const leftAnalysis = analyses[left.path];
    const rightAnalysis = analyses[right.path];
    const leftValue = sort === "duration"
      ? leftAnalysis?.durationSeconds
      : sort === "bpm" ? leftAnalysis?.bpm : leftAnalysis?.musicalKey;
    const rightValue = sort === "duration"
      ? rightAnalysis?.durationSeconds
      : sort === "bpm" ? rightAnalysis?.bpm : rightAnalysis?.musicalKey;
    if (leftValue == null && rightValue == null) return left.title.localeCompare(right.title);
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    const compared = typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true });
    return compared * multiplier || left.title.localeCompare(right.title);
  });
}
import type { LibrarySort, MediaFile, SortDirection, WaveformResult } from "./types";
