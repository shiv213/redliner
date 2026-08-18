import { describe, expect, it } from "vitest";
import { detectSource, extractDroppedUrls, filterMediaFiles, isSupportedUrl, sortMediaFiles } from "./media";
import type { MediaFile } from "./types";

describe("media links", () => {
  it("recognizes core services", () => {
    expect(detectSource("https://open.spotify.com/track/abc")).toBe("Spotify");
    expect(detectSource("https://youtu.be/abc")).toBe("YouTube");
    expect(detectSource("https://soundcloud.com/a/b")).toBe("SoundCloud");
  });

  it("rejects non-web input", () => {
    expect(isSupportedUrl("not a url")).toBe(false);
    expect(isSupportedUrl("file:///tmp/track.mp3")).toBe(false);
  });

  it("extracts URLs from browser drag payloads", () => {
    expect(extractDroppedUrls("# source\nhttps://youtu.be/abc\nTrack title")).toEqual([
      "https://youtu.be/abc",
    ]);
  });

  it("sorts analyzed tracks and keeps unknown values last", () => {
    const files: MediaFile[] = [
      { path: "/b.mp3", title: "B", modifiedMs: 20 },
      { path: "/a.mp3", title: "A", modifiedMs: 10 },
      { path: "/c.mp3", title: "C", modifiedMs: 30 },
    ];
    const analyses = {
      "/a.mp3": { samples: [], durationSeconds: 180, bpm: 90, musicalKey: "Am" },
      "/b.mp3": { samples: [], durationSeconds: 240, bpm: 120, musicalKey: "C" },
    };
    expect(sortMediaFiles(files, analyses, "latest", "desc").map((file) => file.title)).toEqual(["C", "B", "A"]);
    expect(sortMediaFiles(files, analyses, "duration", "desc").map((file) => file.title)).toEqual(["B", "A", "C"]);
    expect(sortMediaFiles(files, analyses, "bpm", "asc").map((file) => file.title)).toEqual(["A", "B", "C"]);
    expect(sortMediaFiles(files, analyses, "key", "desc").map((file) => file.title)).toEqual(["B", "A", "C"]);
  });

  it("filters track titles with fast multi-word matching", () => {
    const files: MediaFile[] = [
      { path: "/a.mp3", title: "Give Me Everything Tonight", modifiedMs: 10 },
      { path: "/b.mp3", title: "Burna Boy - Last Last", modifiedMs: 20 },
    ];
    expect(filterMediaFiles(files, "everything give").map((file) => file.path)).toEqual(["/a.mp3"]);
    expect(filterMediaFiles(files, "  ")).toBe(files);
  });
});
