/** Browser-safe importer contract tests: source text → preview/report → sink. */

import { describe, expect, it } from "vitest";
import { FakeDocumentSink } from "./__tests__/helpers.ts";
import {
  enumerateBatchDocumentIds,
  parseConversationImportText,
  previewConversationImportText,
  runConversationImportText,
} from "./browser.ts";

describe("browser conversation import helpers", () => {
  it("previews ChatGPT JSON through the normalized importer contract", async () => {
    const preview = await previewConversationImportText(
      "chatgpt",
      JSON.stringify([
        {
          conversation_id: "conv-1",
          title: "Build notes",
          current_node: "b",
          mapping: {
            a: {
              id: "a",
              parent: null,
              children: ["b"],
              message: {
                id: "m1",
                author: { role: "user" },
                create_time: 1_700_000_000,
                content: { parts: ["my key is sk-abcdefgh12345678"] },
              },
            },
            b: {
              id: "b",
              parent: "a",
              children: [],
              message: {
                id: "m2",
                author: { role: "assistant" },
                create_time: 1_700_000_060,
                content: { parts: ["Saved that note."] },
              },
            },
          },
        },
      ]),
    );

    expect(preview.counts).toMatchObject({
      conversations: 1,
      messages: 2,
      documents: 1,
      redactions: 1,
    });
    expect(preview.examples[0]).toMatchObject({
      title: "Build notes",
      role: "user",
    });
    expect(preview.examples[0]?.text).toContain("[redacted]");
  });

  it("keeps source selection strict instead of falling back to plain text", () => {
    expect(() => parseConversationImportText("claude", "not json")).toThrow(
      /expects a JSON export/,
    );
  });

  it("imports selected Claude JSON as redacted markdown documents with progress", async () => {
    const sink = new FakeDocumentSink();
    const progress: Array<{ done: number; total: number }> = [];

    const result = await runConversationImportText({
      source: "claude",
      rawText: JSON.stringify([
        {
          uuid: "claude-1",
          name: "Planning",
          chat_messages: [
            { uuid: "m1", sender: "human", text: "hello" },
            {
              uuid: "m2",
              sender: "assistant",
              text: "token Bearer abcdefghijklmnop",
            },
          ],
        },
      ]),
      batchId: "batch-1",
      sink,
      onProgress: (event) => progress.push(event),
    });

    expect(progress).toEqual([{ done: 1, total: 1 }]);
    expect(result.report.summary.added).toBe(1);
    expect(result.report.summary.documentsStored).toBe(1);
    expect(enumerateBatchDocumentIds(result.manifest)).toHaveLength(1);
    const [stored] = sink.stored.values();
    expect(stored.originalFilename).toBe("claude/claude-1.md");
    expect(stored.content).toContain("[redacted]");
    expect(stored.content).not.toContain("Bearer abcdefghijklmnop");
    expect(stored.metadata).toMatchObject({
      import: {
        source: "claude",
        sourceConversationId: "claude-1",
        importBatchId: "batch-1",
      },
    });
  });

  it("surfaces selected-file limits for home-directory sources", async () => {
    const preview = await previewConversationImportText(
      "openclaw",
      "# Memory\n\nFinish the importer integration.",
      { filename: "MEMORY.md" },
    );

    expect(preview.counts).toMatchObject({
      conversations: 1,
      messages: 1,
    });
    expect(preview.warnings[0]).toContain("selected file only");
  });
});
