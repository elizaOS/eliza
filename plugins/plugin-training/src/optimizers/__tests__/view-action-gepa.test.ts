/**
 * GEPA optimization of view-scoped action prompts.
 *
 * The runtime's `action_planner` prompt is what tells the agent how to act while
 * a plugin/builtin view is on screen (see view-action-affinity.ts ->
 * applyActiveViewAwareness). This test proves the real GEPA optimizer
 * (runGepa) converges a deficient planner baseline toward emitting the
 * view-interact capabilities (list-elements / agent-click / agent-fill) and
 * keeps close/hide requests away from destructive delete actions — i.e. GEPA
 * optimizes view actions end-to-end, deterministically, with no live
 * credentials.
 */

import { describe, expect, it } from "vitest";
import { runGepa } from "../gepa.js";
import type {
  LlmAdapter,
  OptimizationExample,
  PromptScorer,
} from "../types.js";

/** The capability a view-scoped planner output must reference to be correct. */
const AGENT_CLICK_CAP = "agent-click";
const AGENT_FILL_CAP = "agent-fill";
const VIEW_GUIDANCE =
  "When a view is active, drive it directly with the view-interact capabilities: list-elements, agent-click, agent-fill, agent-focus.";
const CLOSE_GUIDANCE =
  "Close or hide requests are navigation/shell intents: use CLOSE_VIEW for one view and CLOSE_ALL_VIEWS for all views; never use DELETE_VIEW unless the user explicitly asks to delete, remove, uninstall, destroy, or drop a plugin.";

function makeViewAdapter(): LlmAdapter {
  return {
    async complete(input) {
      const system = input.system ?? "";
      // Reflection: diagnose the missing view-driving guidance.
      if (system.startsWith("You are diagnosing")) {
        return "The prompt never tells the agent it can operate the on-screen view; instruct it to use agent-click / agent-fill on elements by id.";
      }
      // Feedback-guided mutation: inject the view guidance into the prompt.
      if (system.startsWith("Revise the SYSTEM PROMPT")) {
        const prompt =
          input.user
            .split("Current prompt:\n")[1]
            ?.split("\n\nFailure analysis:")[0] ?? input.user;
        return prompt.includes(AGENT_CLICK_CAP)
          ? prompt
          : `${VIEW_GUIDANCE}\n${prompt}`;
      }
      // Compression: collapse blank lines but keep the guidance intact.
      if (system.startsWith("Reduce the SYSTEM PROMPT")) {
        return input.user.replace(/\n{2,}/g, "\n").trim();
      }
      // Crossover: concatenate both parents.
      if (system.startsWith("Merge two candidate")) {
        const a = /PROMPT A:\n([\s\S]*?)\n\nPROMPT B:/.exec(input.user)?.[1];
        const b = /PROMPT B:\n([\s\S]*)$/.exec(input.user)?.[1];
        return `${a ?? ""}\n${b ?? ""}`.trim();
      }
      // Scoring rollout: a planner that knows the capability uses it; otherwise
      // it falls back to telling the user to click manually.
      if (!system.includes(AGENT_CLICK_CAP)) {
        return "Ask the user to click the button themselves.";
      }
      if (/\b(notes?|sticky|calendar|event)\b/i.test(input.user)) {
        return `${AGENT_FILL_CAP} { id: "note-title", value: "Planning" }`;
      }
      return system.includes(AGENT_CLICK_CAP)
        ? `${AGENT_CLICK_CAP} { id: "send" }`
        : "Ask the user to click the button themselves.";
    },
  };
}

function makeViewScorer(): PromptScorer {
  const adapter = makeViewAdapter();
  return async (prompt, examples) => {
    if (examples.length === 0) return 0;
    let total = 0;
    for (const ex of examples) {
      const out = await adapter.complete({
        system: prompt,
        user: ex.input.user,
        temperature: 0,
      });
      if (out.includes(ex.expectedOutput)) total += 1;
    }
    return total / examples.length;
  };
}

/** Realistic view-action planning scenarios across several views. */
function viewActionDataset(): OptimizationExample[] {
  return [
    {
      id: "wallet-send",
      input: { user: "[active view: wallet] send 10 USDC to bob" },
      expectedOutput: AGENT_CLICK_CAP,
    },
    {
      id: "settings-tab",
      input: { user: "[active view: settings] open the connectors section" },
      expectedOutput: AGENT_CLICK_CAP,
    },
    {
      id: "shopify-refresh",
      input: { user: "[active view: shopify] refresh the orders list" },
      expectedOutput: AGENT_CLICK_CAP,
    },
    {
      id: "trajectories-next",
      input: { user: "[active view: trajectories] go to the next page" },
      expectedOutput: AGENT_CLICK_CAP,
    },
    {
      id: "notes-create-sticky",
      input: {
        user: "[active view: notes] add a sticky note titled Planning",
      },
      expectedOutput: AGENT_FILL_CAP,
    },
    {
      id: "calendar-create-event",
      input: {
        user: "[active view: calendar] create an event tomorrow at 09:00",
      },
      expectedOutput: AGENT_FILL_CAP,
    },
  ];
}

function makeCloseAdapter(): LlmAdapter {
  return {
    async complete(input) {
      const system = input.system ?? "";
      if (system.startsWith("You are diagnosing")) {
        return "The prompt treats close/hide as destructive removal; distinguish shell close from plugin deletion and teach CLOSE_VIEW / CLOSE_ALL_VIEWS.";
      }
      if (system.startsWith("Revise the SYSTEM PROMPT")) {
        const prompt =
          input.user
            .split("Current prompt:\n")[1]
            ?.split("\n\nFailure analysis:")[0] ?? input.user;
        return prompt.includes("CLOSE_VIEW")
          ? prompt
          : `${CLOSE_GUIDANCE}\n${prompt}`;
      }
      if (system.startsWith("Reduce the SYSTEM PROMPT")) {
        return input.user.replace(/\n{2,}/g, "\n").trim();
      }
      if (system.startsWith("Merge two candidate")) {
        const a = /PROMPT A:\n([\s\S]*?)\n\nPROMPT B:/.exec(input.user)?.[1];
        const b = /PROMPT B:\n([\s\S]*)$/.exec(input.user)?.[1];
        return `${a ?? ""}\n${b ?? ""}`.trim();
      }
      const user = input.user.toLowerCase();
      if (!system.includes("CLOSE_VIEW")) {
        return 'DELETE_VIEW { view: "settings", confirm: "yes" }';
      }
      if (/\bclose\b.{0,30}\ball\b.{0,30}\bviews?\b/.test(user)) {
        return "CLOSE_ALL_VIEWS {}";
      }
      if (/\b(close|hide|dismiss)\b/.test(user)) {
        return 'CLOSE_VIEW { target: "settings" }';
      }
      return 'DELETE_VIEW { view: "lifeops", confirm: "yes" }';
    },
  };
}

function makeCloseScorer(): PromptScorer {
  const adapter = makeCloseAdapter();
  return async (prompt, examples) => {
    if (examples.length === 0) return 0;
    let total = 0;
    for (const ex of examples) {
      const out = await adapter.complete({
        system: prompt,
        user: ex.input.user,
        temperature: 0,
      });
      if (out.includes(ex.expectedOutput)) total += 1;
    }
    return total / examples.length;
  };
}

function closeRoutingDataset(): OptimizationExample[] {
  return [
    {
      id: "close-settings-view",
      input: { user: "close settings" },
      expectedOutput: "CLOSE_VIEW",
    },
    {
      id: "close-all-views",
      input: { user: "close all views" },
      expectedOutput: "CLOSE_ALL_VIEWS",
    },
    {
      id: "delete-plugin-explicit",
      input: { user: "delete the LifeOps plugin" },
      expectedOutput: "DELETE_VIEW",
    },
  ];
}

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("GEPA optimizes view-scoped action prompts", () => {
  it("converges a view-blind planner baseline toward the view-interact capabilities", async () => {
    const result = await runGepa({
      baselinePrompt:
        "You are the planner. Choose the next tool call for the user's request.",
      dataset: viewActionDataset(),
      scorer: makeViewScorer(),
      llm: makeViewAdapter(),
      options: {
        population: 4,
        generations: 3,
        reflectionBatchSize: 2,
        rng: seededRng(7),
      },
    });

    // Baseline never references the view capability → scores 0.
    expect(result.baseline).toBe(0);
    // The optimized planner uses the view-interact capability and scores higher.
    expect(result.score).toBeGreaterThan(result.baseline);
    expect(result.optimizedPrompt).toContain(AGENT_CLICK_CAP);
    expect(result.optimizedPrompt).toContain(AGENT_FILL_CAP);
    // Lineage records the optimization rounds.
    expect(result.lineage.length).toBeGreaterThan(0);
  });

  it("keeps an already-good view-aware prompt at full score", async () => {
    const result = await runGepa({
      baselinePrompt: `You are the planner. ${VIEW_GUIDANCE}`,
      dataset: viewActionDataset(),
      scorer: makeViewScorer(),
      llm: makeViewAdapter(),
      options: { population: 4, generations: 2, rng: seededRng(2) },
    });
    expect(result.baseline).toBe(1);
    expect(result.optimizedPrompt).toContain(AGENT_CLICK_CAP);
  });

  it("learns close/hide routing without turning close-all into plugin deletion", async () => {
    const result = await runGepa({
      baselinePrompt:
        "You are the planner. Choose view management actions for the user's request.",
      dataset: closeRoutingDataset(),
      scorer: makeCloseScorer(),
      llm: makeCloseAdapter(),
      options: {
        population: 4,
        generations: 3,
        reflectionBatchSize: 2,
        rng: seededRng(11),
      },
    });

    expect(result.baseline).toBeLessThan(1);
    expect(result.score).toBeGreaterThan(result.baseline);
    expect(result.optimizedPrompt).toContain("CLOSE_VIEW");
    expect(result.optimizedPrompt).toContain("CLOSE_ALL_VIEWS");
  });
});
