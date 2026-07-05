/**
 * Budget + separation contract for the split UI guides (#14324): the
 * `uiWidgets` marker guide must stay within its hard size ceiling (so it
 * cannot silently regrow into the old ~150-line combined prompt), the
 * generative JSONL method must live only in `uiGenerative`, and the two
 * providers must keep disjoint firing intents (uiGenerative only on
 * dashboard/table/visualization keywords). Deterministic; no live model.
 */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  UI_WIDGETS_GUIDE,
  uiGenerativeProvider,
  uiWidgetsProvider,
} from "./ui-catalog.ts";

const runtime = {} as unknown as IAgentRuntime;
const state = {} as unknown as State;

describe("uiWidgets — size budget (#14324)", () => {
  it("stays within the 60-line / 1200-token ceiling", () => {
    const lines = UI_WIDGETS_GUIDE.split("\n").length;
    expect(lines).toBeLessThanOrEqual(60);
    // ~4 chars/token heuristic; the ceiling exists to block silent regrowth.
    expect(Math.ceil(UI_WIDGETS_GUIDE.length / 4)).toBeLessThanOrEqual(1200);
  });

  it("teaches every canonical marker and no JSONL method", () => {
    for (const marker of [
      "[CONFIG:pluginId]",
      "[FOLLOWUPS]",
      "[FORM]",
      "[CHECKLIST]",
      "[WORKFLOW]",
    ]) {
      expect(UI_WIDGETS_GUIDE).toContain(marker);
    }
    expect(UI_WIDGETS_GUIDE).not.toContain('{"op":"add"');
    expect(UI_WIDGETS_GUIDE).not.toContain("RFC 6902");
    // The secret prohibition must survive any future compression.
    expect(UI_WIDGETS_GUIDE).toMatch(/NEVER use \[FORM\] for secrets/);
  });
});

describe("uiGenerative — catalog isolation (#14324)", () => {
  it("carries the JSONL method + component catalog, not the marker grammar", async () => {
    const result = await uiGenerativeProvider.get(
      runtime,
      {
        content: {
          text: "show me a dashboard of my metrics",
          channelType: ChannelType.API,
        },
      } as unknown as Memory,
      state,
    );
    expect(result.text).toContain('{"op":"add"');
    expect(result.text).toContain("Available components");
    // Marker grammar lives in uiWidgets only; the generative guide may name
    // [CONFIG:pluginId]/[FORM] to redirect, but must not teach their blocks.
    expect(result.text).not.toContain("[/FOLLOWUPS]");
    expect(result.text).not.toContain("[/FORM]");
    expect(result.text).not.toContain("[/CHECKLIST]");
  });

  it("emits only on generative intent — enforced in get(), not just metadata", async () => {
    const generative = await uiGenerativeProvider.get(
      runtime,
      {
        content: {
          text: "show me a table of my week",
          channelType: ChannelType.API,
        },
      } as unknown as Memory,
      state,
    );
    expect(generative.text).toContain('{"op":"add"');

    const setup = await uiGenerativeProvider.get(
      runtime,
      {
        content: { text: "set up discord", channelType: ChannelType.API },
      } as unknown as Memory,
      state,
    );
    expect(setup.text).toBe("");

    // The cheap widgets guide still serves the setup turn.
    const widgets = await uiWidgetsProvider.get(
      runtime,
      {
        content: { text: "set up discord", channelType: ChannelType.API },
      } as unknown as Memory,
      state,
    );
    expect(widgets.text).toContain("[CONFIG:pluginId]");
  });

  it("is gated off group channels like the widgets guide", async () => {
    for (const provider of [uiWidgetsProvider, uiGenerativeProvider]) {
      const result = await provider.get(
        runtime,
        // Keyword-bearing text so the CHANNEL gate (not the intent gate) is
        // what this test pins for uiGenerative.
        {
          content: {
            text: "show me a dashboard chart",
            channelType: ChannelType.GROUP,
          },
        } as unknown as Memory,
        state,
      );
      expect(result.text).toBe("");
    }
  });

  it("matches whole words only — prose containing keyword substrings stays quiet", async () => {
    const result = await uiGenerativeProvider.get(
      runtime,
      {
        content: {
          // "paragraph" ⊃ "graph", "comfortable" ⊃ "table" — substring
          // matching fired the catalog here; word-boundary matching must not.
          text: "that paragraph was comfortable to read",
          channelType: ChannelType.API,
        },
      } as unknown as Memory,
      state,
    );
    expect(result.text).toBe("");
  });

  it("fires on intent in RECENT HISTORY, and keeps firing mid-iteration via JSONL patches", async () => {
    const neutral = {
      content: {
        text: "make the second column green",
        channelType: ChannelType.API,
      },
    } as unknown as Memory;
    const withHistory = (text: string) =>
      ({
        data: {
          providers: {
            RECENT_MESSAGES: {
              data: { recentMessages: [{ content: { text } }] },
            },
          },
        },
      }) as unknown as State;

    // Bare neutral turn: silent.
    expect((await uiGenerativeProvider.get(runtime, neutral, state)).text).toBe(
      "",
    );
    // Keyword in history: fires.
    expect(
      (
        await uiGenerativeProvider.get(
          runtime,
          neutral,
          withHistory("show me a dashboard of my metrics"),
        )
      ).text,
    ).toContain('{"op":"add"');
    // Agent's own JSONL patches in history (iteration continuation): fires.
    expect(
      (
        await uiGenerativeProvider.get(
          runtime,
          neutral,
          withHistory('{"op":"add","path":"/root","value":"card-1"}'),
        )
      ).text,
    ).toContain('{"op":"add"');
  });

  it("fires on generative intent only — keyword sets are intentionally scoped", () => {
    const gen = (uiGenerativeProvider.relevanceKeywords ?? []).map((k) =>
      k.toLowerCase(),
    );
    for (const term of ["dashboard", "table", "chart", "visualization"]) {
      expect(gen).toContain(term);
    }
    // Plugin-setup intent must NOT wake the expensive catalog.
    for (const term of ["set up", "configure", "api key", "credentials"]) {
      expect(gen).not.toContain(term);
    }
    const widgets = (uiWidgetsProvider.relevanceKeywords ?? []).map((k) =>
      k.toLowerCase(),
    );
    for (const term of ["setup", "configure", "plugin"]) {
      expect(widgets).toContain(term);
    }
  });

  it("both providers keep dynamic composition + admin gating", () => {
    for (const provider of [uiWidgetsProvider, uiGenerativeProvider]) {
      expect(provider.dynamic).toBe(true);
      expect(provider.roleGate).toEqual({ minRole: "ADMIN" });
      // Discovery depends on these (PROVIDERS advertisement / any future
      // by-name request path); deleting one dies silently otherwise.
      expect(provider.description?.length ?? 0).toBeGreaterThan(20);
    }
    // uiWidgets emits constant text → cacheable per-agent. uiGenerative's
    // output varies per turn (intent gate), so it must NOT claim cacheStable.
    expect(uiWidgetsProvider.cacheStable).toBe(true);
    expect(uiWidgetsProvider.cacheScope).toBe("agent");
    expect(uiGenerativeProvider.cacheStable).toBeUndefined();
    // Markers-first ordering when both fire: composeState sorts by
    // (position || 0) then name, and "uiGenerative" < "uiWidgets".
    expect(uiGenerativeProvider.position).toBeGreaterThan(
      uiWidgetsProvider.position ?? 0,
    );
  });
});
