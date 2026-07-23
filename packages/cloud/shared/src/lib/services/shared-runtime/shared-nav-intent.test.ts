import { describe, expect, test } from "bun:test";
import { navIntentActionResult, resolveSharedNavIntent } from "./shared-nav-intent";

describe("resolveSharedNavIntent", () => {
  test.each([
    ["go to settings", "settings", undefined],
    ["open settings", "settings", undefined],
    ["show me my wallet", "wallet", undefined],
    ["open my wallet", "wallet", undefined],
    ["go home", "chat", undefined],
    ["help", "help", undefined],
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
    "help me write an email", // help-verb, not the Help view
  ])("falls through to the LLM for %j", (message) => {
    expect(resolveSharedNavIntent(message)).toBeNull();
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
