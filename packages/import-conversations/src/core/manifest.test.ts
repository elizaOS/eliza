/** Unit tests for the uninstall manifest key + idempotency helpers. Deterministic, in-memory. */

import { describe, expect, it } from "vitest";
import {
  classifyConversation,
  createManifest,
  entryDocumentIds,
  enumerateBatchDocumentIds,
  manifestConversationCount,
  manifestKey,
  recordConversation,
} from "./manifest.ts";

describe("manifestKey", () => {
  it("namespaces by source", () => {
    expect(manifestKey("chatgpt", "abc")).toBe("chatgpt:abc");
  });
});

describe("classifyConversation", () => {
  it("classifies a brand-new conversation as added", () => {
    const m = createManifest("batch-1", "chatgpt", 0);
    expect(classifyConversation(m, "c1", 100)).toBe("added");
  });

  it("classifies an unchanged conversation (same updatedAt)", () => {
    let m = createManifest("batch-1", "chatgpt", 0);
    m = recordConversation(
      m,
      {
        source: "chatgpt",
        sourceConversationId: "c1",
        updatedAt: 100,
        documentIds: ["d1"],
      },
      0,
    );
    expect(classifyConversation(m, "c1", 100)).toBe("unchanged");
    expect(classifyConversation(m, "c1", 50)).toBe("unchanged"); // older = still unchanged
  });

  it("classifies a newer conversation as updated", () => {
    let m = createManifest("batch-1", "chatgpt", 0);
    m = recordConversation(
      m,
      {
        source: "chatgpt",
        sourceConversationId: "c1",
        updatedAt: 100,
        documentIds: ["d1"],
      },
      0,
    );
    expect(classifyConversation(m, "c1", 200)).toBe("updated");
  });

  it("treats a missing incoming updatedAt as 0 (unchanged once recorded)", () => {
    let m = createManifest("batch-1", "chatgpt", 0);
    m = recordConversation(
      m,
      {
        source: "chatgpt",
        sourceConversationId: "c1",
        updatedAt: undefined,
        documentIds: ["d1"],
      },
      0,
    );
    expect(classifyConversation(m, "c1", undefined)).toBe("unchanged");
  });
});

describe("recordConversation", () => {
  it("is immutable (returns a new manifest)", () => {
    const m0 = createManifest("batch-1", "chatgpt", 0);
    const m1 = recordConversation(
      m0,
      {
        source: "chatgpt",
        sourceConversationId: "c1",
        updatedAt: 100,
        documentIds: ["d1"],
      },
      1,
    );
    expect(m0.entries).toEqual({});
    expect(Object.keys(m1.entries)).toEqual(["c1"]);
    expect(m1.updatedAt).toBe(1);
  });

  it("overwrites documentIds on re-record (updated path)", () => {
    let m = createManifest("batch-1", "chatgpt", 0);
    m = recordConversation(
      m,
      {
        source: "chatgpt",
        sourceConversationId: "c1",
        updatedAt: 100,
        documentIds: ["d1", "d2"],
      },
      0,
    );
    m = recordConversation(
      m,
      {
        source: "chatgpt",
        sourceConversationId: "c1",
        updatedAt: 200,
        documentIds: ["d3"],
      },
      1,
    );
    expect(entryDocumentIds(m, "c1")).toEqual(["d3"]);
    expect(m.entries.c1.updatedAt).toBe(200);
  });
});

describe("uninstall enumeration", () => {
  it("enumerates every document id across the batch", () => {
    let m = createManifest("batch-1", "chatgpt", 0);
    m = recordConversation(
      m,
      {
        source: "chatgpt",
        sourceConversationId: "c1",
        updatedAt: 1,
        documentIds: ["a", "b"],
      },
      0,
    );
    m = recordConversation(
      m,
      {
        source: "chatgpt",
        sourceConversationId: "c2",
        updatedAt: 1,
        documentIds: ["c"],
      },
      0,
    );
    expect(enumerateBatchDocumentIds(m).sort()).toEqual(["a", "b", "c"]);
    expect(manifestConversationCount(m)).toBe(2);
  });

  it("returns [] for a conversation with no entry", () => {
    const m = createManifest("batch-1", "chatgpt", 0);
    expect(entryDocumentIds(m, "missing")).toEqual([]);
  });
});
