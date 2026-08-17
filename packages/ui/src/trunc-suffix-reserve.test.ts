import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("trunc suffix reserve strict", () => {
  it("dots suffix reserves 3 chars", () => {
    const save = readFileSync(new URL("./components/chat/SaveCommandModal.tsx", import.meta.url).pathname, "utf8");
    expect(save).toContain("slice(0, 117)}...");
    expect(save).not.toContain("slice(0, 120)}...");
    const runtime = readFileSync(new URL("./components/pages/RuntimeView.tsx", import.meta.url).pathname, "utf8");
    expect(runtime).toContain("slice(0, 97)}...");
    const char = readFileSync(new URL("./components/character/CharacterExperienceWorkspace.tsx", import.meta.url).pathname, "utf8");
    expect(char).toContain("slice(0, 9)}...");
    const chatSend = readFileSync(new URL("./state/useChatSend.ts", import.meta.url).pathname, "utf8");
    const count12 = (chatSend.match(/slice\(0, 12\)\}\.\.\./g) || []).length;
    expect(count12).toBeGreaterThanOrEqual(2);
    expect(chatSend).not.toContain("slice(0, 15)}...");
  });

  it("ellipsis suffix reserves 1 char", () => {
    const mem = readFileSync(new URL("./components/pages/MemoryViewerView.tsx", import.meta.url).pathname, "utf8");
    expect(mem).toContain("slice(0, max - 1)}…");
    expect(mem).not.toContain("slice(0, max)}…");
    const tts = readFileSync(new URL("./utils/tts-debug.ts", import.meta.url).pathname, "utf8");
    expect(tts).toContain("slice(0, maxChars - 1)}…");
    const pill = readFileSync(new URL("./components/composites/chat/chat-message.tsx", import.meta.url).pathname, "utf8");
    expect(pill).toContain("REPLY_PILL_SNIPPET_MAX - 1)}…");
    expect(pill).not.toContain("REPLY_PILL_SNIPPET_MAX)}…");
    const wallet = readFileSync(new URL("./components/pages/browser-wallet-consent-format.ts", import.meta.url).pathname, "utf8");
    expect(wallet).toContain("slice(0, max - 1)}…");
  });

  it("sibling correct remains reserved", () => {
    const adapter = readFileSync("/tmp/eliza-verify2/plugins/plugin-browser/src/message-adapter.ts", "utf8");
    expect(adapter).toContain("slice(0, 497)}...");
    const shell = readFileSync("/tmp/eliza-verify2/packages/ui/src/components/shell/ShellOverlays.tsx", "utf8");
    expect(shell).toContain("slice(0, 77)}...");
  });

  it("no overflow remains in changed files", () => {
    const save = readFileSync(new URL("./components/chat/SaveCommandModal.tsx", import.meta.url).pathname, "utf8");
    expect(save).not.toContain("slice(0, 120)}...");
    const runtime = readFileSync(new URL("./components/pages/RuntimeView.tsx", import.meta.url).pathname, "utf8");
    expect(runtime).not.toContain("slice(0, 100)}...");
    const char = readFileSync(new URL("./components/character/CharacterExperienceWorkspace.tsx", import.meta.url).pathname, "utf8");
    expect(char).not.toContain('value.length > 12 ? `${value.slice(0, 12)}...');
    const chatSend = readFileSync(new URL("./state/useChatSend.ts", import.meta.url).pathname, "utf8");
    expect(chatSend).not.toContain("slice(0, 15)}...");
  });
});
