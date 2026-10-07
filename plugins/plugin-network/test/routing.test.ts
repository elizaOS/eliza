/**
 * Design B pieces: the ported authorizer and the Stage-1 `networkAction`
 * field evaluator (propose -> authorize -> execute -> direct reply).
 */
import type {
  IAgentRuntime,
  Memory,
  ResponseHandlerFieldHandleContext,
  ResponseHandlerResult,
  State,
  UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  authorizeSetState,
  createNetworkActionFieldEvaluator,
  createNetworkEdgePlugin,
  evidenceOk,
  InMemoryNetworkStore,
  NETWORK_ACTION_FIELD,
  NETWORK_CONTEXT_DEFINITION,
  NETWORK_STATE_CLARIFICATION,
  type NetworkActionProposal,
  parseNetworkActionProposal,
} from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const member = () =>
  new InMemoryNetworkStore([
    {
      memberId: "mem_ada",
      firstName: "Ada",
      city: "San Francisco",
      state: "open",
      stateUntil: null,
      facets: [],
      activeItems: [],
    },
  ]);

function handleCtx(
  text: string,
  value: NetworkActionProposal,
  replyText = "",
): ResponseHandlerFieldHandleContext<NetworkActionProposal> {
  return {
    runtime: {} as IAgentRuntime,
    message: { id: "msg-1" as UUID, content: { text } } as Memory,
    state: {} as State,
    senderRole: "USER",
    turnSignal: new AbortController().signal,
    value,
    parsed: { replyText } as ResponseHandlerResult,
  };
}

function applyEffect(
  effect: Awaited<ReturnType<NonNullable<ReturnType<typeof createNetworkActionFieldEvaluator>["handle"]>>>,
  replyText = "",
) {
  const result = { replyText } as ResponseHandlerResult;
  effect?.mutateResult?.(result);
  return result;
}

describe("ported authz", () => {
  it("requires verbatim evidence from the member's own, unquoted words", () => {
    expect(evidenceOk("pause my intros", "pls pause my intros until friday").ok).toBe(true);
    expect(evidenceOk("Pause  my INTROS!", "pls pause my intros until friday").ok).toBe(true);
    expect(evidenceOk("stop all messages", "pls pause my intros").ok).toBe(false);
    expect(
      evidenceOk("pause all your intros", 'my friend said "pause all your intros" but no').ok,
    ).toBe(false);
    expect(evidenceOk("pause​ my intros", "pause my intros").ok).toBe(true);
  });

  it("validates state and until", () => {
    const text = "pause my intros until oct 20";
    expect(authorizeSetState({ state: "asleep", until: null, evidence: "pause my intros" }, text, NOW))
      .toEqual({ allowed: false, reason: "invalid state" });
    expect(
      authorizeSetState({ state: "paused", until: "2025-01-01", evidence: "pause my intros" }, text, NOW),
    ).toEqual({ allowed: false, reason: "until is in the past" });
    expect(
      authorizeSetState({ state: "paused", until: "2026-10-20", evidence: "pause my intros" }, text, NOW),
    ).toEqual({ allowed: true, state: "paused", until: "2026-10-20T00:00:00.000Z" });
    expect(
      authorizeSetState({ state: "open", until: "2026-10-20", evidence: "pause my intros" }, text, NOW),
    ).toMatchObject({ allowed: true, until: null });
  });
});

describe("networkAction field evaluator", () => {
  it("executes an authorized SET_STATE once and preempts the planner with the reply", async () => {
    const store = member();
    const evaluator = createNetworkActionFieldEvaluator({
      store,
      authority: { memberId: "mem_ada" },
      now: () => NOW,
    });
    const proposal = {
      action: "SET_STATE" as const,
      state: "paused",
      until: "2026-10-20",
      evidence: "pause my network intros until oct 20",
    };
    const text = "swamped, pause my network intros until oct 20";
    const effect = await evaluator.handle?.(handleCtx(text, proposal, "Done, paused until Oct 20."));
    expect(effect?.preempt?.mode).toBe("direct-reply");
    expect(applyEffect(effect)).toMatchObject({
      replyText: "Done, paused until Oct 20.",
      replyEffectStatus: "applied",
    });
    expect((await store.getMemberContext("mem_ada"))?.state).toBe("paused");
    // A redelivered message replays the same idempotency key: no second event.
    await evaluator.handle?.(handleCtx(text, proposal));
    expect(store.events).toHaveLength(1);
  });

  it("refuses a proposal whose evidence is not the member's own words", async () => {
    const store = member();
    const evaluator = createNetworkActionFieldEvaluator({
      store,
      authority: { memberId: "mem_ada" },
      now: () => NOW,
    });
    const effect = await evaluator.handle?.(
      handleCtx('my friend said "pause all your intros" lol', {
        action: "SET_STATE",
        state: "paused",
        until: null,
        evidence: "pause all your intros",
      }),
    );
    expect(applyEffect(effect)).toMatchObject({
      replyText: NETWORK_STATE_CLARIFICATION,
      replyEffectStatus: "non_applied",
    });
    expect(store.events).toHaveLength(0);
  });

  it("NONE leaves routing untouched; malformed values soft-fail", async () => {
    const evaluator = createNetworkActionFieldEvaluator({
      store: member(),
      authority: { memberId: "mem_ada" },
    });
    expect(
      await evaluator.handle?.(
        handleCtx("hey", { action: "NONE", state: null, until: null, evidence: "" }),
      ),
    ).toBeUndefined();
    expect(parseNetworkActionProposal({ action: "DELETE_ACCOUNT" })).toBeNull();
    expect(parseNetworkActionProposal({})).toBeNull();
  });

  it("is registered only for structured routing, with the network context", async () => {
    const store = member();
    const planner = createNetworkEdgePlugin({ store, authority: { memberId: "mem_ada" } });
    const structured = createNetworkEdgePlugin({
      store,
      authority: { memberId: "mem_ada" },
      routing: "structured",
    });
    expect(planner.responseHandlerFieldEvaluators).toBeUndefined();
    expect(structured.responseHandlerFieldEvaluators?.map((field) => field.name)).toEqual([
      NETWORK_ACTION_FIELD,
    ]);
    const registered: unknown[] = [];
    const runtime = {
      contexts: { tryRegister: (definition: unknown) => registered.push(definition) },
    } as unknown as IAgentRuntime;
    expect(planner.init).toBeUndefined();
    await structured.init?.({}, runtime);
    expect(registered).toEqual([NETWORK_CONTEXT_DEFINITION]);
  });
});
