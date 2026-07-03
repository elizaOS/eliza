import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ConversationImporterRegistry } from "../core/registry.ts";
import type { NormalizedConversation } from "../core/types.ts";
import {
  chatgptParser,
  detect,
  flattenChatGptConversation,
  parse,
  streamJsonArrayElements,
} from "./chatgpt.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(here, "fixtures", "chatgpt-export");
const CONVERSATIONS_FILE = path.join(EXPORT_DIR, "conversations.json");

async function collect(
  iterable: AsyncIterable<NormalizedConversation>,
): Promise<NormalizedConversation[]> {
  const out: NormalizedConversation[] = [];
  for await (const c of iterable) out.push(c);
  return out;
}

/** Feed a string one code unit at a time to stress chunk-boundary handling. */
async function* byChar(text: string): AsyncGenerator<string> {
  for (const ch of text) yield ch;
}

describe("chatgpt parser: flattenChatGptConversation (tree flatten)", () => {
  it("walks current_node -> root, dropping system/tool-directed/hidden nodes", async () => {
    const [conv1] = await collect(parse(EXPORT_DIR));
    expect(conv1.sourceConversationId).toBe("conv-1");
    expect(conv1.title).toBe("Center a div");
    expect(conv1.meta?.model).toBe("gpt-4o");
    // create_time 1704067200 s -> ms; update_time keeps sub-second precision.
    expect(conv1.createdAt).toBe(1704067200000);
    expect(conv1.updatedAt).toBe(1704067260500);

    const roles = conv1.messages.map((m) => m.role);
    const texts = conv1.messages.map((m) => m.text);
    // root(system,hidden), tool1(recipient!=all), and the a1-alt regen branch
    // are all excluded; the active thread is exactly 5 messages.
    expect(roles).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ]);
    expect(texts[0]).toBe("Hello, how do I center a div?");
    expect(texts[1]).toBe("You can use flexbox.");
    expect(texts[2]).toBe("Show me the CSS.");
  });

  it("prunes the inactive regeneration branch (a1-alt is never emitted)", async () => {
    const [conv1] = await collect(parse(EXPORT_DIR));
    const joined = conv1.messages.map((m) => m.text).join("\n");
    expect(joined).not.toContain("CSS grid");
    expect(joined).not.toContain("Regenerated");
  });

  it("fences code content and placeholders images with an attachment", async () => {
    const [conv1] = await collect(parse(EXPORT_DIR));
    const code = conv1.messages[3];
    expect(code.text).toBe("```css\n.box { display: flex; }\n```");

    const multimodal = conv1.messages[4];
    expect(multimodal.text).toBe(
      "Here is a diagram:\n\n[image: file-service://file-abc]",
    );
    expect(multimodal.attachments).toEqual([
      { name: "file-service://file-abc", kind: "image" },
    ]);
  });

  it("skips a conversation whose active thread has no surfaced messages", async () => {
    // conv-2 is a hidden system root + a tool message -> flattens to nothing.
    const all = await collect(parse(EXPORT_DIR));
    expect(all.map((c) => c.sourceConversationId)).toEqual(["conv-1"]);
  });

  it("falls back to the newest leaf when current_node is missing", () => {
    const conversation = {
      conversation_id: "no-current",
      mapping: {
        root: { id: "root", parent: null, children: ["u1"], message: null },
        u1: {
          id: "u1",
          parent: "root",
          children: ["a1"],
          message: {
            author: { role: "user" },
            create_time: 10,
            content: { content_type: "text", parts: ["hi"] },
          },
        },
        a1: {
          id: "a1",
          parent: "u1",
          children: [],
          message: {
            author: { role: "assistant" },
            create_time: 11,
            content: { content_type: "text", parts: ["hello"] },
          },
        },
      },
    };
    const out = flattenChatGptConversation(conversation);
    expect(out?.messages.map((m) => m.text)).toEqual(["hi", "hello"]);
  });

  it("returns null for an empty conversation id", () => {
    expect(
      flattenChatGptConversation({
        current_node: "x",
        mapping: {
          x: {
            id: "x",
            parent: null,
            children: [],
            message: {
              author: { role: "user" },
              content: { content_type: "text", parts: ["hi"] },
            },
          },
        },
      }),
    ).toBeNull();
  });
});

describe("chatgpt parser: streamJsonArrayElements", () => {
  it("yields the same top-level objects whether fed whole or char-by-char", async () => {
    const json = JSON.stringify([
      { a: 1, s: 'has ] and } and " inside' },
      { b: [1, 2, { c: "nested" }], d: "e" },
      { e: "unicode ★ and escape \\n" },
    ]);

    const whole: unknown[] = [];
    for await (const el of streamJsonArrayElements(asChunks(json))) {
      whole.push(el);
    }
    const streamed: unknown[] = [];
    for await (const el of streamJsonArrayElements(byChar(json))) {
      streamed.push(el);
    }

    expect(streamed).toHaveLength(3);
    expect(streamed).toEqual(whole);
    expect((streamed[0] as { s: string }).s).toBe('has ] and } and " inside');
  });

  it("handles an empty array", async () => {
    const out: unknown[] = [];
    for await (const el of streamJsonArrayElements(byChar("[]"))) out.push(el);
    expect(out).toEqual([]);
  });

  it("throws when the top-level value is not an array", async () => {
    await expect(
      (async () => {
        for await (const _ of streamJsonArrayElements(byChar('{"x":1}'))) {
          // drain
        }
      })(),
    ).rejects.toThrow(/expected a top-level JSON array/);
  });
});

describe("chatgpt parser: detect() + registry", () => {
  it("detects a ChatGPT export dir and a direct conversations.json path", async () => {
    expect(await detect(EXPORT_DIR)).toBe(true);
    expect(await detect(CONVERSATIONS_FILE)).toBe(true);
  });

  it("does not detect a non-existent path", async () => {
    expect(await detect(path.join(here, "does-not-exist"))).toBe(false);
  });

  it("resolves via the registry by detect()", async () => {
    const registry = new ConversationImporterRegistry();
    registry.register(chatgptParser);
    const resolved = await registry.detect(EXPORT_DIR);
    expect(resolved?.source).toBe("chatgpt");
  });
});

/** Split a string into fixed-size chunks (whole-feed comparison helper). */
async function* asChunks(text: string, size = 7): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}
