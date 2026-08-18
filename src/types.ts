export type DownloadStatus = "queued" | "downloading" | "analyzing" | "complete" | "failed";

export interface DownloadItem {
  id: string;
  url: string;
  title: string;
  source: string;
  status: DownloadStatus;
  progress: number;
  error?: string;
}

export interface DownloadProgress {
  jobId: string;
  progress: number;
  status: DownloadStatus;
  title?: string;
}

export interface DownloadResult {
  title: string;
  path: string;
  durationSeconds: number;
  bitrateKbps: number;
}

export interface MediaFile {
  path: string;
  title: string;
  modifiedMs: number;
}

export interface WaveformResult {
  samples: number[];
  durationSeconds: number;
  bpm?: number;
  musicalKey?: string;
}

export type LibrarySort = "latest" | "duration" | "bpm" | "key";
export type SortDirection = "asc" | "desc";
