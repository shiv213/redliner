import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, Check, ChevronRight, Clock3, Coffee, Download, ExternalLink, FolderOpen,
  FolderSearch, Pencil, RefreshCw, Search, Settings, Square, CheckSquare2, Trash2, X, XCircle,
} from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  defaultMusicFolder, detectSource, extractDroppedUrls, filterMediaFiles, isSupportedUrl, sortMediaFiles,
} from "./media";
import type {
  DownloadItem, DownloadProgress, DownloadResult, LibrarySort, MediaFile,
  SortDirection, WaveformResult,
} from "./types";

const FOLDER_KEY = "redliner-output-folder";
const EMPTY_SAMPLES = Array.from({ length: 72 }, () => 0.08);

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function Status({ item }: { item: DownloadItem }) {
  if (item.status === "complete") return <span className="status-icon complete"><Check size={15} /></span>;
  if (item.status === "failed") return <span className="status-icon failed"><XCircle size={16} /></span>;
  if (item.status === "queued") return <span className="status-icon"><Clock3 size={15} /></span>;
  return <span className="row-progress"><i style={{ width: `${item.progress}%` }} /></span>;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.round(seconds % 60).toString().padStart(2, "0")}`;
}

interface WaveformPreviewProps {
  file: MediaFile;
  analysis?: WaveformResult;
  requestAnalysis: (file: MediaFile) => Promise<WaveformResult>;
  revision: number;
}

const WaveformPreview = memo(function WaveformPreview({ file, analysis, requestAnalysis, revision }: WaveformPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || !isTauri() || analysis) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void requestAnalysis(file).catch(() => undefined);
    }, { rootMargin: "120px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [analysis, file, requestAnalysis, revision]);

  const samples = analysis?.samples.length ? analysis.samples : EMPTY_SAMPLES;
  return <div className={`track-analysis ${analysis ? "loaded" : "loading"}`} ref={rootRef}>
    <div className="waveform-preview">
      <svg viewBox="0 0 144 28" preserveAspectRatio="none" aria-label={`Waveform for ${file.title}`}>
        {samples.map((sample, index) => {
          const height = Math.max(1.5, sample * 25);
          const x = (index / Math.max(1, samples.length - 1)) * 142 + 1;
          return <line key={index} x1={x} x2={x} y1={14 - height / 2} y2={14 + height / 2} />;
        })}
      </svg>
      <span>{analysis ? formatDuration(analysis.durationSeconds) : ""}</span>
    </div>
    <span className="track-metric"><b>{analysis?.bpm ?? "—"}</b><small>BPM</small></span>
    <span className="track-metric"><b>{analysis?.musicalKey ?? "—"}</b><small>KEY</small></span>
  </div>;
});

interface LibraryRowProps extends WaveformPreviewProps {
  selected: boolean;
  toggleSelected: (path: string) => void;
  openContextMenu: (event: React.MouseEvent, file: MediaFile) => void;
}

const LibraryRow = memo(function LibraryRow({
  file, selected, toggleSelected, openContextMenu, ...analysisProps
}: LibraryRowProps) {
  return <div
    className={`activity-row library-row ${selected ? "selected" : ""}`}
    onClick={() => toggleSelected(file.path)}
    onContextMenu={(event) => openContextMenu(event, file)}
  >
    <button
      className="selection-button"
      aria-label={`${selected ? "Deselect" : "Select"} ${file.title}`}
      aria-pressed={selected}
      onClick={(event) => { event.stopPropagation(); toggleSelected(file.path); }}
    >{selected ? <CheckSquare2 size={16} /> : <Square size={16} />}</button>
    <div className="track-title" title={file.title}>{file.title}</div>
    <WaveformPreview file={file} {...analysisProps} />
    <span className="status-icon complete" aria-label="Ready"><Check size={15} /></span>
  </div>;
});

function App() {
  const [folder, setFolder] = useState(() => localStorage.getItem(FOLDER_KEY) || defaultMusicFolder());
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [library, setLibrary] = useState<MediaFile[]>([]);
  const [analyses, setAnalyses] = useState<Record<string, WaveformResult>>({});
  const [analysisRevisions, setAnalysisRevisions] = useState<Record<string, number>>({});
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [sort, setSort] = useState<LibrarySort>("latest");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [searchQuery, setSearchQuery] = useState("");
  const [syncError, setSyncError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: MediaFile } | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<MediaFile[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<MediaFile | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [actionError, setActionError] = useState("");
  const [sortingAnalysis, setSortingAnalysis] = useState(false);
  const queueRef = useRef<DownloadItem[]>([]);
  const runningRef = useRef(false);
  const activeUrlsRef = useRef(new Set<string>());
  const librarySignatureRef = useRef("");
  const analysisTasksRef = useRef(new Map<string, Promise<WaveformResult>>());
  const analysisSweepRef = useRef(0);
  const dragDepthRef = useRef(0);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const sortedLibrary = useMemo(
    () => sortMediaFiles(library, analyses, sort, direction),
    [analyses, direction, library, sort],
  );
  const visibleLibrary = useMemo(
    () => filterMediaFiles(sortedLibrary, deferredSearchQuery),
    [deferredSearchQuery, sortedLibrary],
  );
  const selectedFiles = useMemo(
    () => library.filter((file) => selectedPaths.has(file.path)),
    [library, selectedPaths],
  );
  const allVisibleSelected = visibleLibrary.length > 0
    && visibleLibrary.every((file) => selectedPaths.has(file.path));

  const requestAnalysis = useCallback((file: MediaFile) => {
    const taskKey = `${file.path}:${file.modifiedMs}`;
    const running = analysisTasksRef.current.get(taskKey);
    if (running) return running;
    const task = invoke<WaveformResult>("get_waveform", { path: file.path })
      .then((result) => {
        setAnalyses((current) => ({ ...current, [file.path]: result }));
        return result;
      })
      .finally(() => analysisTasksRef.current.delete(taskKey));
    analysisTasksRef.current.set(taskKey, task);
    return task;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<DownloadProgress>("download-progress", ({ payload }) => {
      setItems((current) => current.map((item) => item.id === payload.jobId ? {
        ...item,
        status: payload.status,
        progress: payload.progress,
        title: payload.title || item.title,
      } : item));
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let timer: number | undefined;
    analysisSweepRef.current += 1;
    setSortingAnalysis(false);
    librarySignatureRef.current = "";
    setLibrary([]);
    setSelectedPaths(new Set());
    setAnalyses({});

    async function syncFolder() {
      try {
        const files = await invoke<MediaFile[]>("scan_media_folder", { folder });
        if (cancelled) return;
        const signature = files.map((file) => `${file.path}:${file.modifiedMs}`).join("|");
        if (signature !== librarySignatureRef.current) {
          librarySignatureRef.current = signature;
          setLibrary(files);
          const paths = new Set(files.map((file) => file.path));
          setSelectedPaths((current) => new Set([...current].filter((path) => paths.has(path))));
        }
        setSyncError("");
      } catch (error) {
        if (!cancelled) setSyncError(String(error));
      }
      if (!cancelled) timer = window.setTimeout(() => void syncFolder(), 2000);
    }

    void syncFolder();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [folder]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setDeleteTargets(null);
        setRenameTarget(null);
      }
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", handleKey);
    };
  }, []);

  async function runQueue() {
    if (runningRef.current) return;
    runningRef.current = true;
    while (queueRef.current.length) {
      const item = queueRef.current.shift()!;
      const id = item.id;
      try {
        const result = await invoke<DownloadResult>("download_media", { url: item.url, outputDir: folder, jobId: id });
        setItems((current) => current.map((entry) => entry.id === id ? { ...entry, title: result.title, progress: 100, status: "complete" } : entry));
        window.setTimeout(() => setItems((current) => current.filter((entry) => entry.id !== id)), 1800);
      } catch (error) {
        setItems((current) => current.map((entry) => entry.id === id ? { ...entry, status: "failed", error: String(error) } : entry));
      } finally {
        activeUrlsRef.current.delete(item.url);
      }
    }
    runningRef.current = false;
  }

  function addUrl(raw: string) {
    const url = raw.trim();
    if (!isSupportedUrl(url)) {
      setNotice("Paste a valid music link.");
      window.setTimeout(() => setNotice(""), 2600);
      return;
    }
    if (activeUrlsRef.current.has(url)) {
      setNotice("That link is already in the queue.");
      window.setTimeout(() => setNotice(""), 2600);
      return;
    }
    activeUrlsRef.current.add(url);
    const item: DownloadItem = { id: makeId(), url, title: "Reading link…", source: detectSource(url), status: "queued", progress: 0 };
    setItems((current) => [item, ...current.filter((entry) => entry.url !== url || entry.status !== "failed")]);
    queueRef.current.push(item);
    window.setTimeout(() => void runQueue(), 0);
  }

  async function pasteAndDownload() {
    try {
      const text = isTauri() ? await invoke<string>("read_clipboard") : await navigator.clipboard.readText();
      addUrl(text);
    } catch {
      setNotice("Clipboard access is off. Drop the link here instead.");
    }
  }

  async function importDroppedFiles(files: File[]) {
    if (!files.length) return;
    try {
      const imported = await Promise.all(files.map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return invoke<MediaFile>("import_media_bytes", bytes, {
          headers: {
            "x-redliner-file-name": encodeURIComponent(file.name),
            "x-redliner-output-dir": encodeURIComponent(folder),
          },
        });
      }));
      const count = imported.length;
      setNotice(`${count} ${count === 1 ? "track" : "tracks"} imported.`);
    } catch (error) {
      setNotice(String(error));
    }
    window.setTimeout(() => setNotice(""), 2600);
  }

  async function chooseFolder() {
    const selected = await open({ directory: true, multiple: false, title: "Choose your DJUCED music folder" });
    if (typeof selected === "string") {
      setFolder(selected);
      localStorage.setItem(FOLDER_KEY, selected);
    }
  }

  async function openExternal(url: string) {
    try {
      if (isTauri()) await invoke("open_external_url", { url });
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setNotice("Could not open that link.");
    }
  }

  const toggleSelected = useCallback((path: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const openContextMenu = useCallback((event: React.MouseEvent, file: MediaFile) => {
    event.preventDefault();
    setSelectedPaths((current) => current.has(file.path) ? current : new Set([file.path]));
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 190),
      file,
    });
  }, []);

  async function analyzeForSort(run: number) {
    const missing = library.filter((file) => !analyses[file.path]);
    setSortingAnalysis(missing.length > 0);
    for (let index = 0; index < missing.length; index += 3) {
      if (analysisSweepRef.current !== run) return;
      const batchFiles = missing.slice(index, index + 3);
      const results = await Promise.allSettled(
        batchFiles.map((file) => invoke<WaveformResult>("get_waveform", { path: file.path })),
      );
      const batch: Record<string, WaveformResult> = {};
      results.forEach((result, resultIndex) => {
        if (result.status === "fulfilled") batch[batchFiles[resultIndex].path] = result.value;
      });
      if (Object.keys(batch).length) setAnalyses((current) => ({ ...current, ...batch }));
    }
    if (analysisSweepRef.current === run) setSortingAnalysis(false);
  }

  function changeSort(nextSort: LibrarySort) {
    if (sort === nextSort) {
      setDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSort(nextSort);
    setDirection(nextSort === "latest" ? "desc" : "asc");
    const run = ++analysisSweepRef.current;
    if (nextSort === "latest") {
      setSortingAnalysis(false);
    } else {
      void analyzeForSort(run);
    }
  }

  async function reanalyze(files: MediaFile[]) {
    if (!files.length) return;
    const paths = new Set(files.map((file) => file.path));
    setAnalyses((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !paths.has(path))));
    setAnalysisRevisions((current) => {
      const next = { ...current };
      for (const path of paths) next[path] = (next[path] ?? 0) + 1;
      return next;
    });
    setContextMenu(null);
    setNotice(`Reanalyzing ${files.length === 1 ? files[0].title : `${files.length} tracks`}…`);
    for (let index = 0; index < files.length; index += 3) {
      const batch = files.slice(index, index + 3).map((file) =>
        invoke<WaveformResult>("get_waveform", { path: file.path })
          .then((result) => setAnalyses((current) => ({ ...current, [file.path]: result }))));
      await Promise.allSettled(batch);
    }
    setNotice(files.length === 1 ? "Track reanalyzed." : `${files.length} tracks reanalyzed.`);
    window.setTimeout(() => setNotice(""), 2200);
  }

  async function confirmDelete() {
    if (!deleteTargets?.length) return;
    setActionError("");
    try {
      const paths = deleteTargets.map((file) => file.path);
      const removed = await invoke<number>("trash_media_files", { paths, folder });
      const removedSet = new Set(paths);
      setLibrary((current) => current.filter((file) => !removedSet.has(file.path)));
      setSelectedPaths((current) => new Set([...current].filter((path) => !removedSet.has(path))));
      setAnalyses((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !removedSet.has(path))));
      setDeleteTargets(null);
      setNotice(`${removed} ${removed === 1 ? "track" : "tracks"} moved to Trash.`);
      window.setTimeout(() => setNotice(""), 2600);
    } catch (error) {
      setActionError(String(error));
    }
  }

  async function confirmRename(event: React.FormEvent) {
    event.preventDefault();
    if (!renameTarget) return;
    setActionError("");
    try {
      const renamed = await invoke<MediaFile>("rename_media_file", {
        path: renameTarget.path,
        folder,
        newName: renameValue,
      });
      setLibrary((current) => current.map((file) => file.path === renameTarget.path ? renamed : file));
      setAnalyses((current) => {
        const next = { ...current };
        if (next[renameTarget.path]) next[renamed.path] = next[renameTarget.path];
        delete next[renameTarget.path];
        return next;
      });
      setSelectedPaths((current) => {
        const next = new Set(current);
        if (next.delete(renameTarget.path)) next.add(renamed.path);
        return next;
      });
      setRenameTarget(null);
      setNotice("Track renamed.");
      window.setTimeout(() => setNotice(""), 2200);
    } catch (error) {
      setActionError(String(error));
    }
  }

  async function reveal(file: MediaFile) {
    setContextMenu(null);
    try {
      await invoke("reveal_media_file", { path: file.path, folder });
    } catch (error) {
      setNotice(String(error));
    }
  }

  const active = items.some((item) => item.status === "downloading" || item.status === "analyzing");

  return <main
    className="app-shell"
    onDragEnter={(event) => {
      event.preventDefault();
      dragDepthRef.current += 1;
      setDragging(true);
    }}
    onDragOver={(event) => event.preventDefault()}
    onDragLeave={(event) => {
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragging(false);
    }}
    onDrop={(event) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      const text = event.dataTransfer.getData("text/uri-list")
        || event.dataTransfer.getData("text/x-moz-url")
        || event.dataTransfer.getData("text/plain");
      extractDroppedUrls(text).forEach(addUrl);
      const files = Array.from(event.dataTransfer.files);
      if (files.length) void importDroppedFiles(files);
    }}
  >
    <header className="topbar">
      <div className="wordmark"><span />Redliner</div>
      <button className="icon-button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button>
    </header>

    <section className="workspace">
      <button className="primary-button" onClick={() => void pasteAndDownload()}><Download size={18} />Paste &amp; download</button>
      <div className={`notice ${notice ? "visible" : ""}`}>{notice}</div>

      <div className="activity" aria-label="Music in selected folder">
        <div className="library-toolbar">
          <div className="library-search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="Search tracks"
              autoComplete="off"
              placeholder="Search tracks"
              spellCheck={false}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {searchQuery ? <button aria-label="Clear search" onClick={() => setSearchQuery("")}><X size={14} /></button> : null}
          </div>
        <div className="library-header">
          <div className="library-summary">
            <button
              className="header-select"
              aria-label={allVisibleSelected ? "Deselect visible tracks" : "Select visible tracks"}
              aria-pressed={allVisibleSelected}
              onClick={() => setSelectedPaths((current) => {
                const next = new Set(current);
                visibleLibrary.forEach((file) => allVisibleSelected ? next.delete(file.path) : next.add(file.path));
                return next;
              })}
            >{allVisibleSelected ? <CheckSquare2 size={15} /> : <Square size={15} />}</button>
            <span>Track</span>
            <small className={selectedFiles.length ? "selected-count" : ""}>
              {selectedFiles.length
                ? `${selectedFiles.length} selected`
                : searchQuery
                  ? `${visibleLibrary.length} found`
                  : `${library.length} ${library.length === 1 ? "track" : "tracks"}`}
            </small>
          </div>
          {selectedFiles.length ? <div className="bulk-actions">
            <button onClick={() => void reanalyze(selectedFiles)}><RefreshCw size={13} />Reanalyze</button>
            <button className="danger-text" onClick={() => { setActionError(""); setDeleteTargets(selectedFiles); }}><Trash2 size={13} />Delete</button>
            <button aria-label="Clear selection" onClick={() => setSelectedPaths(new Set())}><X size={14} /></button>
          </div> : <div className="sort-controls" aria-label="Sort tracks">
            {sortingAnalysis ? <RefreshCw className="analyzing-indicator" size={12} aria-label="Analyzing library metadata" /> : null}
            {(["latest", "duration", "bpm", "key"] as LibrarySort[]).map((field) =>
              <button key={field} className={sort === field ? "active" : ""} onClick={() => changeSort(field)}>
                {field === "bpm" ? "BPM" : field[0].toUpperCase() + field.slice(1)}
              </button>)}
            <button
              className="direction-button"
              aria-label={`Sort ${direction === "asc" ? "descending" : "ascending"}`}
              onClick={() => setDirection((current) => current === "asc" ? "desc" : "asc")}
            >{direction === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}</button>
          </div>}
        </div>
        </div>
        {items.map((item) =>
          <div className="activity-row download-row" key={item.id} title={item.error}>
            <div className="track-title">{item.title}</div>
            <div className="download-state"><span>{item.source}</span>{item.status === "analyzing" ? "Analyzing" : item.status === "downloading" ? "Downloading" : item.status === "complete" ? "Ready" : item.status === "failed" ? "Failed" : "Queued"}</div>
            <Status item={item} />
          </div>)}
        {visibleLibrary.map((file) => <LibraryRow
          file={file}
          key={`${file.path}:${file.modifiedMs}`}
          selected={selectedPaths.has(file.path)}
          toggleSelected={toggleSelected}
          openContextMenu={openContextMenu}
          analysis={analyses[file.path]}
          requestAnalysis={requestAnalysis}
          revision={analysisRevisions[file.path] ?? 0}
        />)}
        {items.length === 0 && library.length === 0 ? <div className="empty-row">{syncError || "This folder has no music yet"}</div> : null}
        {library.length > 0 && visibleLibrary.length === 0 ? <div className="empty-row">No tracks match “{searchQuery.trim()}”</div> : null}
      </div>
    </section>

    <footer><span className={active ? "pulse" : "ready-dot"} />{active ? "Working" : "Synced"}<b>·</b>{folder}</footer>

    {dragging ? <div className="drag-overlay" role="status" aria-live="polite">
      <Download size={34} />
      <h1>Drop anywhere to import</h1>
      <p>Links and audio files</p>
    </div> : null}

    {contextMenu ? <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
      <button onClick={() => { setRenameTarget(contextMenu.file); setRenameValue(contextMenu.file.title); setActionError(""); setContextMenu(null); }}><Pencil size={14} />Rename</button>
      <button onClick={() => void reanalyze(selectedFiles.length ? selectedFiles : [contextMenu.file])}><RefreshCw size={14} />Reanalyze</button>
      <button onClick={() => void reveal(contextMenu.file)}><FolderSearch size={14} />Reveal in Finder</button>
      <i />
      <button className="danger-text" onClick={() => { setDeleteTargets(selectedFiles.length ? selectedFiles : [contextMenu.file]); setActionError(""); setContextMenu(null); }}><Trash2 size={14} />Move to Trash</button>
    </div> : null}

    {settingsOpen ? <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
      <section className="settings-panel" onMouseDown={(event) => event.stopPropagation()} aria-modal="true" role="dialog" aria-label="Settings">
        <div className="settings-header"><div><h2>Settings</h2><p>Files land here after download and analysis.</p></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={19} /></button></div>
        <label>DJUCED music folder</label>
        <button className="folder-button" onClick={() => void chooseFolder()}><FolderOpen size={18} /><span>{folder}</span><ChevronRight size={16} /></button>
        <div className="settings-note">Add this folder to DJUCED once. New tracks will then appear after its next library scan.</div>
        <div className="settings-about">
          <span>Redliner is open source and built by <button onClick={() => void openExternal("https://shivvtrivedi.com")}>Shiv Trivedi <ExternalLink size={11} /></button>.</span>
          <button className="coffee-button" onClick={() => void openExternal("https://buymeacoffee.com/shivvtrivedi")}><Coffee size={15} />Buy me a coffee</button>
        </div>
      </section>
    </div> : null}

    {renameTarget ? <div className="modal-backdrop" onMouseDown={() => setRenameTarget(null)}>
      <form className="confirm-panel" onSubmit={(event) => void confirmRename(event)} onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Rename track">
        <h2>Rename track</h2>
        <p>The audio format stays the same.</p>
        <label htmlFor="rename-track">File name</label>
        <input id="rename-track" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
        {actionError ? <div className="action-error">{actionError}</div> : null}
        <div className="modal-actions"><button type="button" onClick={() => setRenameTarget(null)}>Cancel</button><button className="confirm-button" type="submit">Rename</button></div>
      </form>
    </div> : null}

    {deleteTargets ? <div className="modal-backdrop" onMouseDown={() => setDeleteTargets(null)}>
      <section className="confirm-panel" onMouseDown={(event) => event.stopPropagation()} role="alertdialog" aria-modal="true" aria-label="Confirm deletion">
        <h2>Move {deleteTargets.length === 1 ? "track" : `${deleteTargets.length} tracks`} to Trash?</h2>
        <p>{deleteTargets.length === 1 ? deleteTargets[0].title : "They will disappear from Redliner and DJUCED after its next library scan."}</p>
        {actionError ? <div className="action-error">{actionError}</div> : null}
        <div className="modal-actions"><button onClick={() => setDeleteTargets(null)}>Cancel</button><button className="delete-button" onClick={() => void confirmDelete()}>Move to Trash</button></div>
      </section>
    </div> : null}
  </main>;
}

export default App;
