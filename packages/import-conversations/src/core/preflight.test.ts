/** Deterministic unit tests for the import quota/size preflight — no runtime, no I/O; pure decision + estimator functions. */

import { describe, expect, it } from "vitest";
import { conv } from "../__tests__/helpers.ts";
import {
  DEFAULT_IMPORT_LIMITS,
  estimateBundleUsage,
  type ImportLimits,
  preflightImport,
  type TenantImportQuota,
} from "./preflight.ts";
import type { ConversationBundle } from "./types.ts";

const MiB = 1024 * 1024;

describe("preflightImport — size ceilings", () => {
  it("admits a small upload on the direct path (no resumable)", () => {
    const result = preflightImport({ uploadBytes: 2 * MiB });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiresResumable).toBe(false);
      expect(result.estimate.uploadBytes).toBe(2 * MiB);
    }
  });

  it("requires the resumable path once past the direct ceiling", () => {
    const result = preflightImport({
      uploadBytes: DEFAULT_IMPORT_LIMITS.maxDirectUploadBytes + 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiresResumable).toBe(true);
    }
  });

  it("admits an upload exactly at the direct ceiling without resumable", () => {
    const result = preflightImport({
      uploadBytes: DEFAULT_IMPORT_LIMITS.maxDirectUploadBytes,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requiresResumable).toBe(false);
    }
  });

  it("refuses an upload above the resumable hard ceiling whole", () => {
    const result = preflightImport({
      uploadBytes: DEFAULT_IMPORT_LIMITS.maxResumableUploadBytes + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("upload_too_large");
      expect(result.limit).toBe(DEFAULT_IMPORT_LIMITS.maxResumableUploadBytes);
      expect(result.observed).toBe(
        DEFAULT_IMPORT_LIMITS.maxResumableUploadBytes + 1,
      );
    }
  });

  it("honors caller-supplied limits over the defaults", () => {
    const limits: ImportLimits = {
      maxDirectUploadBytes: 100,
      maxResumableUploadBytes: 1000,
    };
    expect(preflightImport({ uploadBytes: 50 }, { limits }).ok).toBe(true);
    const overDirect = preflightImport({ uploadBytes: 500 }, { limits });
    expect(overDirect.ok && overDirect.requiresResumable).toBe(true);
    const overCeiling = preflightImport({ uploadBytes: 1500 }, { limits });
    expect(overCeiling.ok).toBe(false);
  });
});

describe("preflightImport — tenant quota", () => {
  const quota: TenantImportQuota = {
    remainingStorageBytes: 10 * MiB,
    remainingEmbeddingUnits: 100,
    remainingConversations: 5,
  };

  it("admits an import that fits every quota dimension", () => {
    const result = preflightImport(
      {
        uploadBytes: 1 * MiB,
        storageBytes: 5 * MiB,
        embeddingUnits: 50,
        conversationCount: 3,
      },
      { quota },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses when derived storage exceeds the remaining budget", () => {
    const result = preflightImport(
      { uploadBytes: 1 * MiB, storageBytes: 20 * MiB },
      { quota },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("quota_storage_exceeded");
      expect(result.limit).toBe(10 * MiB);
      expect(result.observed).toBe(20 * MiB);
    }
  });

  it("falls back to uploadBytes for storage when storageBytes is omitted", () => {
    const result = preflightImport(
      { uploadBytes: 15 * MiB },
      { quota: { remainingStorageBytes: 10 * MiB } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("quota_storage_exceeded");
      expect(result.observed).toBe(15 * MiB);
    }
  });

  it("refuses when embedding cost exceeds the remaining budget", () => {
    const result = preflightImport(
      { uploadBytes: 1 * MiB, embeddingUnits: 500 },
      { quota },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("quota_embedding_exceeded");
    }
  });

  it("refuses when the conversation count exceeds the remaining budget", () => {
    const result = preflightImport(
      { uploadBytes: 1 * MiB, conversationCount: 9 },
      { quota },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("quota_conversations_exceeded");
      expect(result.observed).toBe(9);
    }
  });

  it("leaves a dimension unbounded when its quota field is omitted", () => {
    const result = preflightImport(
      { uploadBytes: 1 * MiB, embeddingUnits: 10_000, conversationCount: 999 },
      { quota: { remainingStorageBytes: 100 * MiB } },
    );
    expect(result.ok).toBe(true);
  });

  it("checks the size ceiling before quota (too-large wins over quota)", () => {
    const result = preflightImport(
      { uploadBytes: DEFAULT_IMPORT_LIMITS.maxResumableUploadBytes + 1 },
      { quota: { remainingStorageBytes: 1 } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("upload_too_large");
    }
  });
});

describe("preflightImport — malformed input fails fast", () => {
  it("throws on a negative byte count rather than admitting it", () => {
    expect(() => preflightImport({ uploadBytes: -1 })).toThrow(/uploadBytes/);
  });

  it("throws on a non-finite byte count", () => {
    expect(() => preflightImport({ uploadBytes: Number.NaN })).toThrow(
      /uploadBytes/,
    );
  });

  it("throws on malformed optional estimate dimensions", () => {
    expect(() =>
      preflightImport({ uploadBytes: 1, storageBytes: Number.NaN }),
    ).toThrow(/storageBytes/);
    expect(() =>
      preflightImport({ uploadBytes: 1, embeddingUnits: -1 }),
    ).toThrow(/embeddingUnits/);
    expect(() =>
      preflightImport({
        uploadBytes: 1,
        conversationCount: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/conversationCount/);
  });

  it("never mutates the caller's estimate", () => {
    const estimate = { uploadBytes: 1 * MiB, conversationCount: 2 };
    const snapshot = { ...estimate };
    preflightImport(estimate, { quota: { remainingConversations: 1 } });
    expect(estimate).toEqual(snapshot);
  });
});

describe("estimateBundleUsage", () => {
  function bundle(
    conversations: ConversationBundle["conversations"],
  ): ConversationBundle {
    return { source: "chatgpt", conversations };
  }

  it("counts conversations and charges one embedding unit per non-empty message", () => {
    const b = bundle([
      conv({ sourceConversationId: "c1" }),
      conv({ sourceConversationId: "c2" }),
    ]);
    const estimate = estimateBundleUsage(b, 4096);
    expect(estimate.uploadBytes).toBe(4096);
    expect(estimate.conversationCount).toBe(2);
    // conv() has two non-empty messages each.
    expect(estimate.embeddingUnits).toBe(4);
    expect(estimate.storageBytes).toBeGreaterThan(0);
  });

  it("does not charge embedding units for blank/whitespace messages", () => {
    const b = bundle([
      conv({
        sourceConversationId: "c1",
        messages: [
          { role: "user", text: "   " },
          { role: "assistant", text: "real answer" },
        ],
      }),
    ]);
    const estimate = estimateBundleUsage(b, 100);
    expect(estimate.embeddingUnits).toBe(1);
  });

  it("counts UTF-8 bytes (not code units) and includes attachment text", () => {
    const b = bundle([
      conv({
        sourceConversationId: "c1",
        title: undefined,
        messages: [
          {
            role: "user",
            text: "é", // 2 UTF-8 bytes
            attachments: [{ name: "n", kind: "extracted-text", text: "ab" }],
          },
        ],
      }),
    ]);
    const estimate = estimateBundleUsage(b, 0);
    // 2 bytes for "é" + 2 bytes for the attachment "ab".
    expect(estimate.storageBytes).toBe(4);
  });

  it("matches platform UTF-8 encoding for malformed surrogate text", () => {
    const text = "\ud800";
    const b = bundle([
      conv({
        sourceConversationId: "c1",
        title: undefined,
        messages: [{ role: "user", text }],
      }),
    ]);
    expect(estimateBundleUsage(b, 0).storageBytes).toBe(
      new TextEncoder().encode(text).byteLength,
    );
  });

  it("feeds directly into preflightImport for a post-parse quota gate", () => {
    const b = bundle([conv({ sourceConversationId: "c1" })]);
    const estimate = estimateBundleUsage(b, 1 * MiB);
    const result = preflightImport(estimate, {
      quota: { remainingConversations: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("quota_conversations_exceeded");
    }
  });
});
