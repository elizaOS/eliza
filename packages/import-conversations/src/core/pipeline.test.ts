/** End-to-end tests for the ingestion pipeline (redact → render → sink) driven through an in-memory DocumentSink; no runtime, no live model. */

import { describe, expect, it } from "vitest";
import {
  conv,
  FakeDocumentSink,
  streamConversations,
} from "../__tests__/helpers.ts";
import { enumerateBatchDocumentIds } from "./manifest.ts";
import {
  collectImport,
  type ProgressEvent,
  runImport,
  uninstallBatch,
} from "./pipeline.ts";
import { REDACTED_PLACEHOLDER } from "./redact.ts";
import type { NormalizedConversation } from "./types.ts";

const NOW = () => 1_700_000_000_000;

function opts(sink: FakeDocumentSink, extra: Record<string, unknown> = {}) {
  return {
    source: "chatgpt" as const,
    batchId: "batch-1",
    sink,
    entityId: "entity-42",
    now: NOW,
    ...extra,
  };
}

describe("pipeline end-to-end", () => {
  it("parses → stores → reports with progress events", async () => {
    const sink = new FakeDocumentSink();
    const conversations = [
      conv({ sourceConversationId: "c1", title: "First" }),
      conv({ sourceConversationId: "c2", title: "Second" }),
    ];
    const progress: ProgressEvent[] = [];
    const gen = runImport(
      streamConversations(conversations),
      opts(sink, { total: conversations.length }),
    );
    let res = await gen.next();
    while (!res.done) {
      progress.push(res.value);
      res = await gen.next();
    }
    const { report, manifest } = res.value;

    expect(report.summary.added).toBe(2);
    expect(report.summary.documentsStored).toBe(2);
    expect(sink.stored.size).toBe(2);

    // progress events, one per conversation, with total
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({ processed: 1, total: 2 });
    expect(progress[1]).toMatchObject({ processed: 2, total: 2 });

    // provenance/scoping applied
    const [doc] = sink.stored.values();
    expect(doc.scope).toBe("user-private");
    expect(doc.scopedToEntityId).toBe("entity-42");
    expect(doc.addedFrom).toBe("import");
    expect(doc.contentType).toBe("text/markdown");
    const md = doc.metadata as {
      import: Record<string, unknown>;
      tags: string[];
    };
    expect(md.import.source).toBe("chatgpt");
    expect(md.import.importBatchId).toBe("batch-1");
    expect(md.tags).toContain("import");
    expect(md.tags).toContain("import:chatgpt");

    // manifest recorded both
    expect(Object.keys(manifest.entries).sort()).toEqual(["c1", "c2"]);
  });

  it("redacts secrets before storing", async () => {
    const sink = new FakeDocumentSink();
    const c = conv({
      sourceConversationId: "c1",
      messages: [{ role: "user", text: "my key sk-abcdefgh12345678 leaked" }],
    });
    await collectImport(streamConversations([c]), opts(sink));
    const [doc] = sink.stored.values();
    expect(doc.content).toContain(REDACTED_PLACEHOLDER);
    expect(doc.content).not.toContain("sk-abcdefgh12345678");
  });

  it("skips conversations with no renderable messages", async () => {
    const sink = new FakeDocumentSink();
    const empty = conv({ sourceConversationId: "empty", messages: [] });
    const { report } = await collectImport(
      streamConversations([empty]),
      opts(sink),
    );
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.added).toBe(0);
    expect(sink.stored.size).toBe(0);
    expect(report.items[0].reason).toBeDefined();
  });
});

describe("idempotent re-import", () => {
  it("re-import of the same export is all unchanged (no new docs)", async () => {
    const sink = new FakeDocumentSink();
    const conversations = [conv({ sourceConversationId: "c1" })];

    const first = await collectImport(
      streamConversations(conversations),
      opts(sink),
    );
    expect(first.report.summary.added).toBe(1);

    const second = await collectImport(
      streamConversations(conversations),
      opts(sink, { manifest: first.manifest }),
    );
    expect(second.report.summary.unchanged).toBe(1);
    expect(second.report.summary.added).toBe(0);
    // no additional documents stored
    expect(sink.stored.size).toBe(1);
  });

  it("re-import with a newer updatedAt re-imports as updated and replaces docs", async () => {
    const sink = new FakeDocumentSink();
    const v1 = conv({
      sourceConversationId: "c1",
      updatedAt: 1000,
      messages: [{ role: "user", text: "v1 content" }],
    });
    const first = await collectImport(streamConversations([v1]), opts(sink));
    const oldId = enumerateBatchDocumentIds(first.manifest)[0];

    const v2 = conv({
      sourceConversationId: "c1",
      updatedAt: 2000,
      messages: [{ role: "user", text: "v2 content changed" }],
    });
    const second = await collectImport(
      streamConversations([v2]),
      opts(sink, { manifest: first.manifest }),
    );
    expect(second.report.summary.updated).toBe(1);
    // old document was deleted, new one stored
    expect(sink.deleted).toContain(oldId);
    const newIds = enumerateBatchDocumentIds(second.manifest);
    expect(newIds).not.toContain(oldId);
    expect(
      [...sink.stored.values()].some((d) => d.content.includes("v2 content")),
    ).toBe(true);
  });
});

describe("content dedup via sink", () => {
  it("reports a content-dedup skip when the sink dedups an added conversation", async () => {
    const sink = new FakeDocumentSink({ dedup: true });
    const c = conv({ sourceConversationId: "c1" });
    // Store the doc directly first so the pipeline's add is deduped.
    const parts = await collectImport(streamConversations([c]), opts(sink));
    expect(parts.report.summary.added).toBe(1);

    // A brand-new batch (fresh manifest) importing identical content → sink
    // dedups → pipeline reports a content-dedup skip.
    const sink2 = new FakeDocumentSink({ dedup: true });
    // Pre-seed sink2 with the identical rendered doc.
    const first = await collectImport(streamConversations([c]), opts(sink2));
    const second = await collectImport(
      streamConversations([c]),
      opts(sink2, { batchId: "batch-2" }), // fresh manifest, same content
    );
    expect(first.report.summary.added).toBe(1);
    expect(second.report.summary.skipped).toBe(1);
    expect(second.report.items[0].reason).toContain("dedup");
  });
});

describe("dry run", () => {
  it("classifies + reports without storing", async () => {
    const sink = new FakeDocumentSink();
    const c = conv({ sourceConversationId: "c1" });
    const { report } = await collectImport(
      streamConversations([c]),
      opts(sink, { dryRun: true }),
    );
    expect(report.dryRun).toBe(true);
    expect(report.summary.added).toBe(1);
    // nothing stored
    expect(sink.stored.size).toBe(0);
    expect(sink.addCalls).toHaveLength(0);
  });

  it("does not require a sink for a dry run", async () => {
    const c = conv({ sourceConversationId: "c1" });
    const { report } = await collectImport(streamConversations([c]), {
      source: "chatgpt",
      batchId: "b",
      dryRun: true,
      now: NOW,
    });
    expect(report.summary.added).toBe(1);
  });

  it("throws if a non-dry-run has no sink", async () => {
    const c = conv({ sourceConversationId: "c1" });
    await expect(
      collectImport(streamConversations([c]), {
        source: "chatgpt",
        batchId: "b",
        now: NOW,
      }),
    ).rejects.toThrow(/DocumentSink is required/);
  });
});

describe("uninstall", () => {
  it("deletes every document in the batch", async () => {
    const sink = new FakeDocumentSink();
    const conversations = [
      conv({ sourceConversationId: "c1" }),
      conv({ sourceConversationId: "c2" }),
    ];
    const { manifest } = await collectImport(
      streamConversations(conversations),
      opts(sink),
    );
    const deletedCount = await uninstallBatch(sink, manifest);
    expect(deletedCount).toBe(2);
    expect(sink.stored.size).toBe(0);
  });
});

describe("streaming (laziness)", () => {
  it("processes a lazy async iterable without materializing it upfront", async () => {
    const sink = new FakeDocumentSink();
    const yielded: string[] = [];
    const conversations = [
      conv({ sourceConversationId: "c1" }),
      conv({ sourceConversationId: "c2" }),
      conv({ sourceConversationId: "c3" }),
    ];
    const stream = streamConversations(conversations, (c) =>
      yielded.push(c.sourceConversationId),
    );

    // Drive the generator one step at a time; after the first progress event,
    // only the first conversation should have been pulled from the source.
    const gen = runImport(stream, opts(sink));
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(yielded).toEqual(["c1"]); // lazy: c2/c3 not yet pulled

    // drain the rest
    let res = await gen.next();
    while (!res.done) res = await gen.next();
    expect(yielded).toEqual(["c1", "c2", "c3"]);
    expect(sink.stored.size).toBe(3);
  });

  it("never buffers: an infinite-until-limit generator is consumed incrementally", async () => {
    const sink = new FakeDocumentSink();
    let produced = 0;
    async function* lazy(): AsyncIterable<NormalizedConversation> {
      while (produced < 5) {
        produced += 1;
        yield conv({ sourceConversationId: `c${produced}` });
      }
    }
    const events: number[] = [];
    const gen = runImport(lazy(), opts(sink));
    let res = await gen.next();
    while (!res.done) {
      events.push(produced); // producer count at the moment of each event
      res = await gen.next();
    }
    // Each event observes at most one-ahead production (streaming, not buffered).
    for (let i = 0; i < events.length; i++) {
      expect(events[i]).toBe(i + 1);
    }
  });
});
