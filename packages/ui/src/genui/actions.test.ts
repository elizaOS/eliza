/**
 * Unit coverage for the GenUI dispatch layer itself (`routeElizaGenUiAction`,
 * the prefix-handler factory, and the routed error type): gate messages,
 * first-match-wins handler ordering, argument identity, and result/rejection
 * passthrough. Pure functions driven against the real boot-time registry; no
 * live agent.
 */
import { describe, expect, it } from "vitest";
import {
  createElizaGenUiPrefixActionHandler,
  ElizaGenUiActionError,
  routeElizaGenUiAction,
} from "./actions";
import type { ElizaGenUiAction, ElizaGenUiActionResult } from "./types";

const act = (name: string): ElizaGenUiAction => ({ event: { name } });

const context = {
  target: "plugin" as const,
  componentId: "comp-1",
  sessionId: "session-1",
};

/** Counts invocations without replacing the behaviour under test. */
const recordingHandler = (
  prefixes: readonly string[],
  result: Promise<ElizaGenUiActionResult> | ElizaGenUiActionResult,
) => {
  const seen: { actions: ElizaGenUiAction[]; contexts: unknown[] } = {
    actions: [],
    contexts: [],
  };
  const handler = createElizaGenUiPrefixActionHandler(
    prefixes,
    async (action, actionContext) => {
      seen.actions.push(action);
      seen.contexts.push(actionContext);
      return await result;
    },
  );
  return { handler, seen };
};

const rejectedValue = async <T>(promise: Promise<T>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
};

describe("ElizaGenUiActionError", () => {
  it("is an Error named after itself and carrying the offending action", () => {
    const action = act("model.pick");
    const error = new ElizaGenUiActionError("bad action", action);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ElizaGenUiActionError);
    expect(error.name).toBe("ElizaGenUiActionError");
    expect(error.message).toBe("bad action");
    expect(error.action).toBe(action);
  });
});

describe("createElizaGenUiPrefixActionHandler", () => {
  it("accepts a name under any of its prefixes", () => {
    const { handler } = recordingHandler(["setup.", "model."], { ok: true });
    expect(handler.canHandle("setup.provider")).toBe(true);
    expect(handler.canHandle("model.pick")).toBe(true);
  });

  it("rejects a name that merely contains a prefix mid-string", () => {
    const { handler } = recordingHandler(["model."], { ok: true });
    expect(handler.canHandle("remodel.pick")).toBe(false);
    expect(handler.canHandle("xmodel.y")).toBe(false);
  });

  it("handles nothing when constructed with no prefixes", () => {
    const { handler } = recordingHandler([], { ok: true });
    expect(handler.canHandle("")).toBe(false);
    expect(handler.canHandle("anything.at.all")).toBe(false);
  });

  it("delegates handle and resolves the delegate's result", async () => {
    const { handler } = recordingHandler(["voice."], {
      ok: false,
      error: "voice unavailable",
    });
    expect(handler.canHandle("voice.speak")).toBe(true);
    await expect(handler.handle(act("voice.speak"), context)).resolves.toEqual({
      ok: false,
      error: "voice unavailable",
    });
  });
});

describe("routeElizaGenUiAction", () => {
  it("throws a routed error naming an unregistered action and attaching it", async () => {
    const action = act("regtest_actions_unregistered.doThing");
    const { handler } = recordingHandler([""], { ok: true });
    const error = (await rejectedValue(
      routeElizaGenUiAction(action, context, [handler]),
    )) as ElizaGenUiActionError;
    expect(error).toBeInstanceOf(ElizaGenUiActionError);
    expect(error.message).toBe(
      'Generated UI action "regtest_actions_unregistered.doThing" is not allowed.',
    );
    expect(error.action).toBe(action);
  });

  it("throws a no-handler error when the allowed name has no matching handler", async () => {
    const { handler } = recordingHandler(["connector."], { ok: true });
    const error = (await rejectedValue(
      routeElizaGenUiAction(act("model.pick"), context, [handler]),
    )) as ElizaGenUiActionError;
    expect(error).toBeInstanceOf(ElizaGenUiActionError);
    expect(error.message).toBe(
      'No generated UI action handler registered for "model.pick".',
    );
    expect(error.action.event.name).toBe("model.pick");
  });

  it("throws the no-handler error for an empty handler list", async () => {
    const error = (await rejectedValue(
      routeElizaGenUiAction(act("runtime.restart"), context, []),
    )) as ElizaGenUiActionError;
    expect(error.message).toBe(
      'No generated UI action handler registered for "runtime.restart".',
    );
  });

  it("gives the first matching handler priority over later ones", async () => {
    const first = recordingHandler(["trace."], { ok: true, data: "first" });
    const second = recordingHandler(["trace."], { ok: true, data: "second" });
    const result = await routeElizaGenUiAction(act("trace.show"), context, [
      first.handler,
      second.handler,
    ]);
    expect(result).toEqual({ ok: true, data: "first" });
    expect(first.seen.actions).toHaveLength(1);
    expect(second.seen.actions).toHaveLength(0);
  });

  it("skips handlers that cannot handle the event name", async () => {
    const skip = recordingHandler(["provider."], { ok: true, data: "wrong" });
    const match = recordingHandler(["capability."], {
      ok: true,
      data: "right",
    });
    const result = await routeElizaGenUiAction(
      act("capability.grant"),
      context,
      [skip.handler, match.handler],
    );
    expect(result).toEqual({ ok: true, data: "right" });
    expect(skip.seen.actions).toHaveLength(0);
    expect(match.seen.actions).toHaveLength(1);
  });

  it("passes the same action and context objects to the winning handler", async () => {
    const action = act("setup.begin");
    const payloadAction: ElizaGenUiAction = {
      event: { name: "setup.begin", payload: { providerId: "openai" } },
    };
    const { handler, seen } = recordingHandler(["setup."], { ok: true });
    await routeElizaGenUiAction(action, context, [handler]);
    await routeElizaGenUiAction(payloadAction, context, [handler]);
    expect(seen.actions[0]).toBe(action);
    expect(seen.contexts[0]).toBe(context);
    expect(seen.actions[1].event.payload).toEqual({ providerId: "openai" });
  });

  it("propagates a handler rejection unchanged", async () => {
    const failure = new Error("handler exploded");
    const failing = createElizaGenUiPrefixActionHandler(
      ["dynamicView."],
      async () => {
        throw failure;
      },
    );
    const error = await rejectedValue(
      routeElizaGenUiAction(act("dynamicView.swap"), context, [failing]),
    );
    expect(error).toBe(failure);
  });
});
