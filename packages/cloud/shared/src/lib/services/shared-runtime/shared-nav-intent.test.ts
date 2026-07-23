import { describe, expect, test } from "bun:test";
import { __matcherData, MATCHER_VIEW_IDS } from "@elizaos/shared/views/view-command-matcher";
import { navIntentActionResult, resolveSharedNavIntent } from "./shared-nav-intent";

describe("resolveSharedNavIntent", () => {
  test.each([
    ["go to settings", "settings", undefined],
    ["open settings", "settings", undefined],
    // The matcher's "wallet" id translates to the client's builtin "inventory"
    // tab — the raw "wallet" id resolves to nothing on the PWA (#17032).
    ["show me my wallet", "inventory", undefined],
    ["open my wallet", "inventory", undefined],
    ["go home", "chat", undefined],
    ["what's on my calendar", "calendar", undefined],
    ["open my inbox", "inbox", undefined],
    // Multilingual (matcher parity)
    ["muéstrame mi calendario", "calendar", undefined],
    ["打开设置", "settings", undefined],
    ["설정 열기", "settings", undefined],
  ])("navigates %j -> %s", (message, viewId, subview) => {
    const intent = resolveSharedNavIntent(message);
    expect(intent).not.toBeNull();
    expect(intent?.viewId).toBe(viewId);
    expect(intent?.subview).toBe(subview);
    expect(intent?.reply).toMatch(/^Opening .+ for you\.$/);
  });

  test("voice-change is a Settings › Voice deep-link", () => {
    for (const message of [
      "change my voice",
      "change the voice",
      "update voice settings",
      "switch my voice",
    ]) {
      const intent = resolveSharedNavIntent(message);
      expect(intent?.viewId).toBe("settings");
      expect(intent?.subview).toBe("voice");
    }
  });

  test.each([
    "",
    "   ",
    "hello how are you",
    "tell me a joke",
    "I love your voice", // talking about voice, not changing it
    "can you explain how wallets work",
    "help me write an email", // help-verb, not a Help surface
    // The matcher resolves a bare "help" to its "help" id, but no Help surface
    // exists on any client, so the nav table omits it and the utterance falls
    // through to the normal LLM turn instead of a not-found navigation (#17032).
    "help",
  ])("falls through to the LLM for %j", (message) => {
    expect(resolveSharedNavIntent(message)).toBeNull();
  });

  test("no resolvable utterance ever emits an unroutable viewId", () => {
    // Sweep every noun the matcher knows: whatever a matcher-recognised
    // utterance resolves to, the emitted CLIENT id must never be "wallet"
    // (builtin tab is "inventory") or "help" (no surface exists) — the exact
    // drift that produced a confident reply into a silent launcher grid.
    for (const matcherId of MATCHER_VIEW_IDS) {
      for (const noun of __matcherData.VIEW_NOUNS[matcherId]) {
        const intent = resolveSharedNavIntent(`open ${noun}`);
        if (!intent) continue;
        expect(intent.viewId).not.toBe("wallet");
        expect(intent.viewId).not.toBe("help");
      }
    }
  });

  test("navIntentActionResult matches the PWA VIEWS handoff contract", () => {
    const intent = resolveSharedNavIntent("go to settings");
    expect(intent).not.toBeNull();
    const result = navIntentActionResult(intent!);
    // findViewActionHandoff (packages/ui/src/view-action-handoff.ts) reads
    // exactly these fields: actionName VIEWS, success true, values.mode show,
    // values.viewId.
    expect(result.actionName).toBe("VIEWS");
    expect(result.success).toBe(true);
    expect(result.values.mode).toBe("show");
    expect(result.values.viewId).toBe("settings");
    expect(result.values.source).toBe("agent");
    expect(result.text).toBe(intent!.reply);
  });

  test("navIntentActionResult carries the settings subview for a voice deep-link", () => {
    const intent = resolveSharedNavIntent("change my voice");
    const result = navIntentActionResult(intent!);
    expect(result.values.viewId).toBe("settings");
    expect(result.values.subview).toBe("voice");
  });
});
