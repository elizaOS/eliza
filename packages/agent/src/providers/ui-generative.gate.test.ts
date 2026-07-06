/**
 * Runtime-behavior contract for the uiGenerative intent gate (#14324
 * follow-up): the landed split's keyword tests only pin list MEMBERSHIP, but
 * `relevanceKeywords` is consumed by no selection engine — on the v5 path both
 * providers compose on every general ADMIN planner turn, so the in-get gate is
 * the only thing keeping the ~150-line catalog off non-generative turns. These
 * tests pin the gate's actual firing behavior: word-boundary matching (prose
 * containing keyword substrings stays quiet), history-window firing, the
 * JSONL-continuation signal, markers-first ordering, and cache semantics.
 * Deterministic; no live model.
 */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { uiGenerativeProvider, uiWidgetsProvider } from "./ui-catalog.ts";

const runtime = {} as unknown as IAgentRuntime;
const emptyState = {} as unknown as State;

const msg = (text: string, channelType: ChannelType = ChannelType.API) =>
  ({ content: { text, channelType } }) as unknown as Memory;

const withHistory = (text: string) =>
  ({
    data: {
      providers: {
        RECENT_MESSAGES: { data: { recentMessages: [{ content: { text } }] } },
      },
    },
  }) as unknown as State;

describe("uiGenerative — enforced intent gate", () => {
  it("fires on generative intent and stays silent on plugin setup", async () => {
    const generative = await uiGenerativeProvider.get(
      runtime,
      msg("show me a dashboard of my metrics"),
      emptyState,
    );
    expect(generative.text).toContain('{"op":"add"');

    const setup = await uiGenerativeProvider.get(
      runtime,
      msg("set up discord"),
      emptyState,
    );
    expect(setup.text).toBe("");
  });

  it("matches whole words only — prose containing keyword substrings stays quiet", async () => {
    // "paragraph" ⊃ "graph", "comfortable" ⊃ "table", "guide" ⊃ "ui" — bare
    // substring matching fired the catalog on all of these.
    const result = await uiGenerativeProvider.get(
      runtime,
      msg("that paragraph in the guide was comfortable to read"),
      emptyState,
    );
    expect(result.text).toBe("");
  });

  it("fires on intent in recent history, not just the current message", async () => {
    const neutral = msg("make the second column green");
    expect(
      (await uiGenerativeProvider.get(runtime, neutral, emptyState)).text,
    ).toBe("");
    expect(
      (
        await uiGenerativeProvider.get(
          runtime,
          neutral,
          withHistory("build a dashboard of my week"),
        )
      ).text,
    ).toContain('{"op":"add"');
  });

  it("keeps firing mid-iteration via the agent's own JSONL patches", async () => {
    const neutral = msg("add a filter row");
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

  it("channel gate holds even with keyword-bearing text", async () => {
    const result = await uiGenerativeProvider.get(
      runtime,
      msg("show me a dashboard chart", ChannelType.GROUP),
      emptyState,
    );
    expect(result.text).toBe("");
  });

  it("renders after uiWidgets on dual-fire turns and drops stale cache claims", () => {
    // composeState orders by (position || 0) then name; "uiGenerative" sorts
    // before "uiWidgets", so markers-first needs an explicit position.
    expect(uiGenerativeProvider.position).toBeGreaterThan(
      uiWidgetsProvider.position ?? 0,
    );
    // uiWidgets emits constant text → cacheable; uiGenerative varies per turn.
    expect(uiWidgetsProvider.cacheStable).toBe(true);
    expect(uiGenerativeProvider.cacheStable).toBeUndefined();
  });

  it("both providers carry a discovery description", () => {
    for (const provider of [uiWidgetsProvider, uiGenerativeProvider]) {
      expect(provider.description?.length ?? 0).toBeGreaterThan(20);
    }
  });
});
