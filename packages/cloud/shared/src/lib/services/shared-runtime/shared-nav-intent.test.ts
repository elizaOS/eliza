import { describe, expect, test } from "bun:test";
import { DOCUMENTS_NAV_VOCABULARY } from "@elizaos/shared/views/shared-nav-targets";
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
    ["open cloud apps", "cloud-apps", undefined],
    ["打开云应用", "cloud-apps", undefined],
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

  test.each([
    ["en", "Knowledge", "open Knowledge"],
    ["es", "Conocimiento", "abre Conocimiento"],
    ["pt", "Conhecimento", "abra Conhecimento"],
    ["ja", "ナレッジ", "ナレッジを開いて"],
    ["ko", "지식", "지식을 열어"],
    ["vi", "Tri thức", "mở Tri thức"],
    ["zh-CN", "知识", "打开知识"],
    ["tl", "Kaalaman", "buksan ang Kaalaman"],
  ] as const)(
    "%s Knowledge label %j emits the canonical documents handoff",
    (locale, label, message) => {
      expect(DOCUMENTS_NAV_VOCABULARY.localizedLabels[locale]).toBe(label);
      const intent = resolveSharedNavIntent(message);
      expect(intent).toEqual({
        viewId: "documents",
        label: "Knowledge",
        reply: "Opening Knowledge for you.",
      });
      const result = navIntentActionResult(intent!);
      expect(result.values).toEqual({
        mode: "show",
        viewId: "documents",
        source: "agent",
      });
    },
  );

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
    "showcase knowledge",
    "open knowledgebase",
    "open knowledgeable",
    "el conocimiento es poder",
    "abre conocimientos avanzados",
    "conhecimento é importante",
    "abra conhecimentos gerais",
    "ナレッジについて教えて",
    "ナレッジワーカーを開いて",
    "지식에 대해 설명해줘",
    "지식인을 열어",
    "tri thức rất quan trọng",
    "知识就是力量",
    "打开知识产权",
    "mahalaga ang kaalaman",
    // The matcher resolves a bare "help" to its "help" id, but no Help surface
    // exists on any client, so the nav table omits it and the utterance falls
    // through to the normal LLM turn instead of navigating nowhere (#17032).
    "help",
    // The matcher knows "camera", but the camera view is AOSP-fork-only — on
    // the clients a shared-tier agent serves (web/desktop/iOS) /camera has no
    // real surface — so the nav table omits it and the utterance falls
    // through to the LLM turn.
    "open the camera",
    "take a photo",
    "list my cloud apps",
    "show my cloud apps",
    "list my deployed apps",
    "do not open cloud apps",
    "how do I open cloud apps?",
    "when I open cloud apps it crashes",
    "open cloud apps documentation",
    "open the cloud app Acme",
  ])("falls through to the LLM for %j", (message) => {
    expect(resolveSharedNavIntent(message)).toBeNull();
  });

  test('never emits "wallet" (no such client id) nor "help"/"camera" (no shared-tier surfaces)', () => {
    // Sweep every noun the matcher knows: whatever a matcher-recognised
    // utterance resolves to, the emitted CLIENT id must never be "wallet"
    // (no client registers that id anywhere — the builtin tab is "inventory"),
    // "help" (no Help surface exists), or "camera" (AOSP-fork-only; absent on
    // the web/desktop/iOS clients a shared-tier agent serves) — the exact
    // drift that produced a confident reply into a silent launcher grid.
    for (const matcherId of MATCHER_VIEW_IDS) {
      for (const noun of __matcherData.VIEW_NOUNS[matcherId]) {
        const intent = resolveSharedNavIntent(`open ${noun}`);
        if (!intent) continue;
        expect(intent.viewId).not.toBe("wallet");
        expect(intent.viewId).not.toBe("help");
        expect(intent.viewId).not.toBe("camera");
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
