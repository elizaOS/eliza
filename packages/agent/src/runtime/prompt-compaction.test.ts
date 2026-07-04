/**
 * Prompt compaction decides which action schemas keep full param detail and
 * strips conversation noise for non-coding chat. Getting intent detection wrong
 * either bloats the prompt (cost/latency) or strips the very params the planner
 * must fill — so detection, the full-param set expansion, and the
 * history-preservation guards for coding/wallet turns are pinned here.
 * Deterministic — pure-function tests over crafted prompt strings, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  buildFullParamActionSet,
  compactConversationHistory,
  detectIntentCategories,
  INTENT_ACTION_MAP,
  UNIVERSAL_ACTIONS,
  validateIntentActionMap,
} from "./prompt-compaction.ts";

const received = (msg: string) => `# Received Message\n${msg}\n`;

describe("detectIntentCategories", () => {
  it("detects coding, wallet, and views intents from the user message", () => {
    expect(
      detectIntentCategories(received("please refactor the repository")),
    ).toContain("coding");
    expect(
      detectIntentCategories(received("swap some eth for usdc")),
    ).toContain("wallet");
    expect(
      detectIntentCategories(received("what's on my calendar today")),
    ).toContain("views");
  });

  it("returns no categories for plain chat", () => {
    expect(
      detectIntentCategories(received("good morning, how are you")),
    ).toEqual([]);
  });

  it("reads intent from a <task> block too", () => {
    expect(
      detectIntentCategories("<task>open a pull request</task>"),
    ).toContain("coding");
  });
});

describe("buildFullParamActionSet", () => {
  it("always includes the universal actions", () => {
    const set = buildFullParamActionSet([]);
    for (const a of UNIVERSAL_ACTIONS) expect(set.has(a)).toBe(true);
  });

  it("coding intent also pulls in terminal + issues actions", () => {
    const set = buildFullParamActionSet(["coding"]);
    expect(set.has("TASKS")).toBe(true);
    for (const a of INTENT_ACTION_MAP.terminal) expect(set.has(a)).toBe(true);
  });

  it("keeps caller-supplied extra actions at full detail", () => {
    const set = buildFullParamActionSet([], ["MY_VIEW_ACTION"]);
    expect(set.has("MY_VIEW_ACTION")).toBe(true);
  });
});

describe("validateIntentActionMap", () => {
  it("warns about unregistered mapped actions, except opt-in plugin actions", () => {
    const warned: string[] = [];
    validateIntentActionMap([], { warn: (m) => warned.push(m) });
    const joined = warned.join("\n");
    expect(joined).toMatch(/SHELL/);
    expect(joined).toMatch(/VIEWS/);
    // TASKS comes from an opt-in plugin → must stay quiet when absent.
    expect(joined).not.toMatch(/"TASKS"/);
  });

  it("aggregates all missing actions into a single warn line, with per-action debug detail", () => {
    const warned: string[] = [];
    const debugs: string[] = [];
    validateIntentActionMap([], {
      warn: (m) => warned.push(m),
      debug: (m) => debugs.push(m),
    });
    // One summary line, not one warn per missing (category, action) pair.
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("INTENT_ACTION_MAP:");
    expect(warned[0]).toContain("not registered");
    expect(warned[0]).toContain("terminal: SHELL, TERMINAL_SHELL, RUNTIME");
    expect(warned[0]).toContain("plugins not loaded in this config");
    // Per-action detail is preserved at debug level (opt-in TASKS still skipped).
    expect(
      debugs.some((d) => d.includes('INTENT_ACTION_MAP["terminal"]')),
    ).toBe(true);
    expect(debugs.join("\n")).not.toMatch(/"TASKS"/);
  });

  it("stays silent when every mapped action is registered", () => {
    const all = [
      ...new Set(Object.values(INTENT_ACTION_MAP).flatMap((s) => [...s])),
    ];
    const warned: string[] = [];
    validateIntentActionMap(all, { warn: (m) => warned.push(m) });
    expect(warned).toEqual([]);
  });
});

describe("compactConversationHistory", () => {
  const history =
    "# Conversation Messages\n" +
    "12:53 (17 minutes ago) [b850bc30-45f8-0041-a00a-83df46d8555d]\n" +
    "Alice: hello there\n" +
    "(Eliza's internal thought: user greeted me)\n" +
    "(Eliza's actions: REPLY)\n" +
    "# Received Message\nhi\n";

  it("strips thoughts, action lists, and entity UUIDs for plain chat", () => {
    const out = compactConversationHistory(history);
    expect(out).toContain("Alice: hello there");
    expect(out).not.toContain("internal thought");
    expect(out).not.toContain("b850bc30-45f8-0041-a00a-83df46d8555d");
  });

  it("preserves full history when coding or wallet intent is present", () => {
    const coding = history.replace(
      "# Received Message\nhi",
      "# Received Message\nrefactor the repo",
    );
    expect(compactConversationHistory(coding)).toBe(coding);
  });
});
