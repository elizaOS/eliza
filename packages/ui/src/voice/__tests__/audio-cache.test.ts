/** Verifies the process-wide synthesized-audio cache's byte-bounded LRU contract. */

import { afterEach, describe, expect, it } from "vitest";
import {
  globalAudioCache,
  MAX_CACHED_AUDIO_BYTES,
  readCachedAudio,
  rememberCachedAudio,
} from "../voice-chat-types";

afterEach(() => {
  globalAudioCache.clear();
});

describe("generated audio cache", () => {
  it("retains an entry exactly at the byte budget", () => {
    const bytes = new Uint8Array(MAX_CACHED_AUDIO_BYTES);
    rememberCachedAudio("exact", bytes);
    expect(readCachedAudio("exact")).toBe(bytes);
  });

  it("rejects a single response larger than the byte budget", () => {
    rememberCachedAudio(
      "oversized",
      new Uint8Array(MAX_CACHED_AUDIO_BYTES + 1),
    );
    expect(globalAudioCache.has("oversized")).toBe(false);
  });

  it("evicts the least-recently-used audio by cumulative bytes", () => {
    const half = Math.floor(MAX_CACHED_AUDIO_BYTES / 2);
    rememberCachedAudio("oldest", new Uint8Array(half));
    rememberCachedAudio("recent", new Uint8Array(half));
    expect(readCachedAudio("oldest")).toBeDefined();

    rememberCachedAudio("new", new Uint8Array(1));

    expect(globalAudioCache.has("recent")).toBe(false);
    expect(globalAudioCache.has("oldest")).toBe(true);
    expect(globalAudioCache.has("new")).toBe(true);
  });
});
