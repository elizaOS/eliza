/** Unit tests for ConversationImporterRegistry registration, lookup, and source-detection dispatch. Deterministic. */

import { describe, expect, it } from "vitest";
import {
  type ConversationImporter,
  ConversationImporterRegistry,
} from "./registry.ts";
import type { NormalizedConversation } from "./types.ts";

function fakeParser(
  source: string,
  detect: (input: unknown) => boolean,
): ConversationImporter<unknown> {
  return {
    source,
    detect,
    async *parse(): AsyncIterable<NormalizedConversation> {
      // empty stream for registry tests
    },
  };
}

describe("ConversationImporterRegistry", () => {
  it("registers and looks up a parser by source", () => {
    const reg = new ConversationImporterRegistry();
    reg.register(fakeParser("chatgpt", () => true));
    expect(reg.has("chatgpt")).toBe(true);
    expect(reg.get("chatgpt")?.source).toBe("chatgpt");
    expect(reg.sources()).toEqual(["chatgpt"]);
    expect(reg.all()).toHaveLength(1);
  });

  it("rejects a parser with an empty source", () => {
    const reg = new ConversationImporterRegistry();
    expect(() => reg.register(fakeParser("", () => true))).toThrow();
  });

  it("unregister removes the parser", () => {
    const reg = new ConversationImporterRegistry();
    const off = reg.register(fakeParser("hermes", () => true));
    expect(reg.has("hermes")).toBe(true);
    off();
    expect(reg.has("hermes")).toBe(false);
  });

  it("unregister only removes the same instance (no clobber after replace)", () => {
    const reg = new ConversationImporterRegistry();
    const off1 = reg.register(fakeParser("claude", () => true));
    reg.register(fakeParser("claude", () => false)); // replaces
    off1(); // must NOT remove the replacement
    expect(reg.has("claude")).toBe(true);
    expect(reg.get("claude")?.detect(null)).toBe(false);
  });

  it("detect returns the first matching parser in registration order", async () => {
    const reg = new ConversationImporterRegistry();
    reg.register(fakeParser("chatgpt", (i) => i === "cg"));
    reg.register(fakeParser("claude", (i) => i === "cl"));
    expect((await reg.detect("cl"))?.source).toBe("claude");
    expect((await reg.detect("cg"))?.source).toBe("chatgpt");
    expect(await reg.detect("nope")).toBeUndefined();
  });

  it("supports async detect predicates", async () => {
    const reg = new ConversationImporterRegistry();
    reg.register({
      source: "async-src",
      detect: async () => true,
      async *parse() {},
    });
    expect((await reg.detect({}))?.source).toBe("async-src");
  });

  it("clear removes everything", () => {
    const reg = new ConversationImporterRegistry();
    reg.register(fakeParser("a", () => true));
    reg.register(fakeParser("b", () => true));
    reg.clear();
    expect(reg.sources()).toEqual([]);
  });
});
