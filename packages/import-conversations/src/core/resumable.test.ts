/**
 * Resumable upload state tests for import-conversations.
 *
 * These cover the pure metadata contract that future HTTP/object-store routes
 * will persist between chunk requests: range/hash validation, idempotent
 * retries, hydration validation, and merge semantics for independently accepted
 * chunks. Bytes remain outside this state object.
 */

import { describe, expect, it } from "vitest";
import {
  createResumableUploadSession,
  findMissingResumableUploadRanges,
  getResumableUploadProgress,
  mergeResumableUploadSessions,
  recordResumableChunk,
  resumableSha256Hex,
  validateResumableUploadSession,
} from "./resumable.ts";

describe("resumable import upload state", () => {
  it("creates deterministic open sessions", () => {
    const session = createResumableUploadSession({
      sessionId: "import-batch-a",
      uploadBytes: 10,
      chunkSize: 4,
      now: () => 123,
    });

    expect(session).toEqual({
      sessionId: "import-batch-a",
      uploadBytes: 10,
      chunkSize: 4,
      chunkCount: 3,
      createdAt: 123,
      updatedAt: 123,
      status: "open",
      chunks: {},
    });
  });

  it("records chunks, progress, missing ranges, and completion", () => {
    let session = createResumableUploadSession({
      sessionId: "s1",
      uploadBytes: 10,
      chunkSize: 4,
      now: () => 0,
    });

    const first = recordResumableChunk(session, {
      index: 1,
      offset: 4,
      bytes: "bbbb",
      now: () => 10,
    });
    expect(first.status).toBe("accepted");
    session = first.session;
    expect(first.progress).toEqual({
      receivedBytes: 4,
      uploadBytes: 10,
      receivedChunks: 1,
      chunkCount: 3,
      complete: false,
    });
    expect(findMissingResumableUploadRanges(session)).toEqual([
      { start: 0, endExclusive: 4, chunkIndex: 0 },
      { start: 8, endExclusive: 10, chunkIndex: 2 },
    ]);

    session = recordResumableChunk(session, {
      index: 0,
      offset: 0,
      bytes: "aaaa",
      now: () => 20,
    }).session;
    const final = recordResumableChunk(session, {
      index: 2,
      offset: 8,
      bytes: "cc",
      now: () => 30,
    });

    expect(final.session.status).toBe("complete");
    expect(final.progress.complete).toBe(true);
    expect(final.progress.receivedBytes).toBe(10);
    expect(findMissingResumableUploadRanges(final.session)).toEqual([]);
  });

  it("treats identical duplicate chunks as idempotent retries", () => {
    const session = createResumableUploadSession({
      sessionId: "s1",
      uploadBytes: 4,
      chunkSize: 4,
      now: () => 0,
    });
    const first = recordResumableChunk(session, {
      index: 0,
      offset: 0,
      bytes: "abcd",
      now: () => 10,
    });
    const retry = recordResumableChunk(first.session, {
      index: 0,
      offset: 0,
      bytes: "abcd",
      now: () => 20,
    });

    expect(retry.status).toBe("duplicate");
    expect(retry.session).toEqual(first.session);
    expect(retry.chunk.receivedAt).toBe(10);
  });

  it("rejects conflicting duplicate chunks", () => {
    const session = createResumableUploadSession({
      sessionId: "s1",
      uploadBytes: 4,
      chunkSize: 4,
      now: () => 0,
    });
    const first = recordResumableChunk(session, {
      index: 0,
      offset: 0,
      bytes: "abcd",
    });

    expect(() =>
      recordResumableChunk(first.session, {
        index: 0,
        offset: 0,
        bytes: "wxyz",
      }),
    ).toThrow(/conflicts/);
  });

  it("rejects wrong byte ranges and wrong chunk hashes", () => {
    const session = createResumableUploadSession({
      sessionId: "s1",
      uploadBytes: 10,
      chunkSize: 4,
      now: () => 0,
    });

    expect(() =>
      recordResumableChunk(session, { index: 1, offset: 5, bytes: "bbbb" }),
    ).toThrow(/offset/);
    expect(() =>
      recordResumableChunk(session, { index: 0, offset: 0, bytes: "too-long" }),
    ).toThrow(/length/);
    expect(() =>
      recordResumableChunk(session, {
        index: 0,
        offset: 0,
        bytes: "aaaa",
        sha256: resumableSha256Hex("bbbb"),
      }),
    ).toThrow(/sha256/);
    expect(() =>
      recordResumableChunk(session, { index: 3, offset: 12, bytes: "" }),
    ).toThrow(/outside/);
  });

  it("keeps completed duplicate retries idempotent", () => {
    const session = createResumableUploadSession({
      sessionId: "s1",
      uploadBytes: 4,
      chunkSize: 4,
    });
    const complete = recordResumableChunk(session, {
      index: 0,
      offset: 0,
      bytes: "aaaa",
    }).session;

    const retry = recordResumableChunk(complete, {
      index: 0,
      offset: 0,
      bytes: "aaaa",
    });

    expect(retry.status).toBe("duplicate");
    expect(retry.progress.complete).toBe(true);
  });

  it("rejects unsafe or nonsensical session metadata", () => {
    expect(() =>
      createResumableUploadSession({
        sessionId: "../escape",
        uploadBytes: 1,
        chunkSize: 1,
      }),
    ).toThrow(/sessionId/);
    expect(() =>
      createResumableUploadSession({
        sessionId: "s1",
        uploadBytes: 0,
        chunkSize: 1,
      }),
    ).toThrow(/uploadBytes/);
    expect(() =>
      createResumableUploadSession({
        sessionId: "s1",
        uploadBytes: 1,
        chunkSize: Number.NaN,
      }),
    ).toThrow(/chunkSize/);
  });

  it("computes progress from persisted state without mutation", () => {
    const session = createResumableUploadSession({
      sessionId: "s1",
      uploadBytes: 6,
      chunkSize: 3,
      now: () => 0,
    });
    const next = recordResumableChunk(session, {
      index: 0,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3]),
    }).session;

    expect(getResumableUploadProgress(session).receivedBytes).toBe(0);
    expect(getResumableUploadProgress(next)).toMatchObject({
      receivedBytes: 3,
      receivedChunks: 1,
      complete: false,
    });
  });

  it("validates hydrated persisted state before computing progress", () => {
    const session = createResumableUploadSession({
      sessionId: "s1",
      uploadBytes: 8,
      chunkSize: 4,
      now: () => 0,
    });
    const next = recordResumableChunk(session, {
      index: 0,
      offset: 0,
      bytes: "aaaa",
    }).session;

    expect(validateResumableUploadSession(next)).toEqual(next);
    expect(() =>
      validateResumableUploadSession({
        ...next,
        chunkCount: 99,
      }),
    ).toThrow(/chunkCount/);
    expect(() =>
      getResumableUploadProgress({
        ...next,
        status: "complete",
      }),
    ).toThrow(/status/);
    expect(() =>
      findMissingResumableUploadRanges({
        ...next,
        chunks: {
          ...next.chunks,
          0: {
            ...next.chunks[0],
            byteLength: 3,
          },
        },
      }),
    ).toThrow(/byteLength/);
    expect(() =>
      validateResumableUploadSession({
        ...next,
        chunks: {
          "00": next.chunks[0],
        },
      }),
    ).toThrow(/canonical/);
    expect(() =>
      validateResumableUploadSession({
        ...next,
        updatedAt: 0,
      }),
    ).toThrow(/updatedAt/);
  });

  it("merges non-overlapping accepted chunks from concurrent stale reads", () => {
    const base = createResumableUploadSession({
      sessionId: "s1",
      uploadBytes: 8,
      chunkSize: 4,
      now: () => 0,
    });
    const firstWriter = recordResumableChunk(base, {
      index: 0,
      offset: 0,
      bytes: "aaaa",
      now: () => 10,
    }).session;
    const secondWriter = recordResumableChunk(base, {
      index: 1,
      offset: 4,
      bytes: "bbbb",
      now: () => 20,
    }).session;

    const merged = mergeResumableUploadSessions(
      base,
      firstWriter,
      secondWriter,
    );

    expect(merged.status).toBe("complete");
    expect(merged.updatedAt).toBe(20);
    expect(Object.keys(merged.chunks).sort()).toEqual(["0", "1"]);
    expect(getResumableUploadProgress(merged)).toEqual({
      receivedBytes: 8,
      uploadBytes: 8,
      receivedChunks: 2,
      chunkCount: 2,
      complete: true,
    });
  });

  it("rejects conflicting merged chunks and mismatched session identities", () => {
    const base = createResumableUploadSession({
      sessionId: "s1",
      uploadBytes: 4,
      chunkSize: 4,
      now: () => 0,
    });
    const first = recordResumableChunk(base, {
      index: 0,
      offset: 0,
      bytes: "aaaa",
      now: () => 10,
    }).session;
    const conflict = recordResumableChunk(base, {
      index: 0,
      offset: 0,
      bytes: "bbbb",
      now: () => 20,
    }).session;

    expect(() => mergeResumableUploadSessions(base, first, conflict)).toThrow(
      /conflicts/,
    );
    expect(() =>
      mergeResumableUploadSessions(base, {
        ...first,
        sessionId: "other",
      }),
    ).toThrow(/sessionId/);
  });
});
