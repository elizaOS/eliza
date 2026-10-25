/** Checks the real REST/coordinator envelope, closed failure transport and the public authority argument order. */
import { describe, expect, test } from "bun:test";
import { ChannelType } from "@elizaos/core/protocol";
import { APICallError } from "ai";
import { coordinateSharedBridge } from "../../shared/src/lib/services/shared-runtime/conversation-coordinator";
import type { PersonalSharedFallbackAccountState } from "../../shared/src/lib/services/shared-runtime/personal-fallback-account-state";
import { sharedRestMessageSend } from "../../shared/src/lib/services/shared-runtime/shared-rest-adapter";
import {
  recordSharedRuntimeFailureDiagnostic,
  SharedRuntimeTurnError,
  sharedModelFailureDiagnostic,
} from "../../shared/src/lib/services/shared-runtime/shared-runtime-errors";

const agent = {
  id: "agent-trace-fixture",
  organization_id: "org-fixture",
  user_id: "user-fixture",
  execution_tier: "shared",
} as never;
const executionCtx = { waitUntil(_work: Promise<unknown>) {} };
function namespaceFor(respond: (body: Record<string, unknown>) => Response) {
  const bodies: Array<Record<string, unknown>> = [];
  return {
    bodies,
    namespace: {
      getByName(_name: string) {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const body = (await new Request(input, init).json()) as Record<
              string,
              unknown
            >;
            bodies.push(body);
            return respond(body);
          },
        };
      },
    },
  };
}
function reply(body: Record<string, unknown>) {
  return Response.json({
    jsonrpc: "2.0",
    id: (body.rpc as { id: string }).id,
    result: { text: "coordinated" },
  });
}
const accountState: PersonalSharedFallbackAccountState = {
  access: "shared_fallback",
  state: "shared_active",
  reason: "billing_suspended",
  dedicatedMemory: "unavailable",
  generation: 1,
  dedicatedRetainedUntil: null,
  recoveryAction: { kind: "add_credits", path: "/cloud/billing" },
};

describe("Personal Shared public trace and authority slots", () => {
  test("keeps Dedicated fallback account state before the server trace in a DM", async () => {
    const fixture = namespaceFor(reply);
    await sharedRestMessageSend(
      agent,
      "room-fixture",
      "hello",
      "Eliza",
      executionCtx,
      fixture.namespace,
      "message-fixture",
      "platform",
      undefined,
      "hello",
      undefined,
      accountState,
      "server-trace-fixture",
    );
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.bodies[0]).toMatchObject({
      operation: "personal-bridge",
      traceId: "server-trace-fixture",
      trustedAccountState: accountState,
      channel: { type: ChannelType.DM },
    });
    const rpc = fixture.bodies[0].rpc as { params: Record<string, unknown> };
    expect(rpc.params).not.toHaveProperty("traceId");
    expect(rpc.params).not.toHaveProperty("trustedAccountState");
    expect(rpc.params.clientMessageId).toBe("message-fixture");
  });
  test("keeps group channel semantics with an empty fallback account slot", async () => {
    const fixture = namespaceFor(reply);
    await sharedRestMessageSend(
      agent,
      "group-fixture",
      "hello",
      "Eliza",
      executionCtx,
      fixture.namespace,
      "group-message",
      "platform",
      undefined,
      "hello",
      { type: ChannelType.GROUP, source: "telegram" },
      undefined,
      "group-trace",
    );
    expect(fixture.bodies[0]).toMatchObject({
      traceId: "group-trace",
      channel: { type: ChannelType.GROUP, source: "telegram" },
    });
    expect(fixture.bodies[0]).not.toHaveProperty("trustedAccountState");
  });
  test("existing uncorrelated callers keep fresh client IDs and no trace authority", async () => {
    const fixture = namespaceFor(reply);
    for (let i = 0; i < 2; i += 1)
      await sharedRestMessageSend(
        agent,
        "room-fixture",
        "hello",
        "Eliza",
        executionCtx,
        fixture.namespace,
      );
    for (const body of fixture.bodies)
      expect(body).not.toHaveProperty("traceId");
    const ids = fixture.bodies.map((body) => (body.rpc as { id: string }).id);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
function diagnostic() {
  const cause = new APICallError({
    message: "A system message must appear first.",
    url: "https://example.invalid/provider",
    requestBodyValues: { private: "PRIVATE_REQUEST" },
    statusCode: 400,
    responseBody: JSON.stringify({
      error: {
        message: "A system message must appear first.",
        type: "invalid_request_error",
        param: "messages",
        private: "PRIVATE_PROVIDER",
      },
    }),
  });
  recordSharedRuntimeFailureDiagnostic(cause, {
    modelInvocationStarted: true,
    failureKind: "unknown",
    terminalFailurePresent: false,
    terminalMode: "unknown",
    lastModelCompletion: null,
    modelFailure: sharedModelFailureDiagnostic(cause, "generate"),
  });
  return new SharedRuntimeTurnError("Shared turn failed.", cause);
}
async function transported(status: number, body: Record<string, unknown>) {
  const fixture = namespaceFor(() => Response.json(body, { status }));
  try {
    await coordinateSharedBridge(
      agent,
      {
        jsonrpc: "2.0",
        id: "message-fixture",
        method: "message.send",
        params: { text: "hello", roomId: "room-fixture" },
      },
      { namespace: fixture.namespace, executionCtx },
    );
  } catch (error) {
    return error;
  }
  throw new Error("Failure fixture returned a successful turn");
}
describe("closed Shared diagnostic transport", () => {
  test("retains sanitized provider detail across the actual coordinator error boundary", async () => {
    const original = diagnostic();
    const body = JSON.parse(
      JSON.stringify({
        success: false,
        error: "Shared turn failed.",
        code: "shared_runtime_turn_failed",
        failureName: original.failureName,
        retryable: original.retryable,
        failureDiagnostic: original.failureDiagnostic,
      }),
    );
    const received = await transported(500, body);
    expect(received).toBeInstanceOf(SharedRuntimeTurnError);
    expect((received as SharedRuntimeTurnError).failureDiagnostic).toEqual(
      original.failureDiagnostic,
    );
    expect(
      JSON.stringify((received as SharedRuntimeTurnError).failureDiagnostic),
    ).not.toContain("PRIVATE_");
  });
  test("drops forged nested metadata without changing the public failure disposition", async () => {
    const original = diagnostic();
    const forged = JSON.parse(JSON.stringify(original.failureDiagnostic));
    forged.modelFailure.providerError.category = "PRIVATE_ARBITRARY_CATEGORY";
    const received = (await transported(500, {
      code: "shared_runtime_turn_failed",
      failureName: original.failureName,
      retryable: false,
      failureDiagnostic: forged,
    })) as SharedRuntimeTurnError;
    expect(received.failureName).toBe(original.failureName);
    expect(received.retryable).toBe(false);
    expect(received.failureDiagnostic).toBeUndefined();
  });
  test("an inconsistent status and retry flag cannot carry diagnostic authority", async () => {
    const original = diagnostic();
    const received = (await transported(500, {
      code: "shared_runtime_turn_failed",
      failureName: "SharedRuntimeProviderUnavailableError",
      retryable: true,
      failureDiagnostic: original.failureDiagnostic,
    })) as SharedRuntimeTurnError;
    expect(received.failureName).toBe("SharedRuntimeUnknownError");
    expect(received.retryable).toBe(false);
    expect(received.failureDiagnostic).toBeUndefined();
  });
});

describe("Personal Shared cancellation authority stays outside the RPC", () => {
  test("stops the real REST and coordinator fetch without moving account state or server trace", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<AbortSignal>();
    let stopped = false;
    const bodies: Array<Record<string, unknown>> = [];
    const namespace = {
      getByName(_name: string) {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const signal = init?.signal;
            if (!signal)
              throw new Error("Expected coordinator cancellation signal");
            bodies.push(
              (await new Request(input, init).json()) as Record<
                string,
                unknown
              >,
            );
            entered.resolve(signal);
            return await new Promise<Response>((_resolve, reject) => {
              const stop = () => {
                stopped = true;
                reject(
                  signal.reason ?? new DOMException("Aborted", "AbortError"),
                );
              };
              if (signal.aborted) stop();
              else signal.addEventListener("abort", stop, { once: true });
            });
          },
        };
      },
    };
    const pending = sharedRestMessageSend(
      agent,
      "room-fixture",
      "hello",
      "Eliza",
      executionCtx,
      namespace,
      "cancelled-message",
      "platform",
      undefined,
      "hello",
      { type: ChannelType.DM, source: "telegram" },
      accountState,
      "cancelled-trace",
      controller.signal,
    );
    pending.catch(() => undefined);
    const signal = await entered.promise;
    controller.abort(
      new DOMException("Caller stopped this turn", "AbortError"),
    );
    await expect(pending).rejects.toThrow();
    expect(signal.aborted).toBe(true);
    expect(stopped).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      operation: "personal-bridge",
      traceId: "cancelled-trace",
      trustedAccountState: accountState,
      channel: { type: ChannelType.DM, source: "telegram" },
    });
    const rpc = bodies[0].rpc as {
      id: string;
      params: Record<string, unknown>;
    };
    expect(rpc.id).toBe("cancelled-message");
    expect(rpc.params.clientMessageId).toBe("cancelled-message");
    expect(rpc.params).not.toHaveProperty("abortSignal");
    expect(rpc.params).not.toHaveProperty("signal");
    expect(rpc.params).not.toHaveProperty("traceId");
    expect(rpc.params).not.toHaveProperty("trustedAccountState");
    expect(bodies[0]).not.toHaveProperty("abortSignal");
    expect(bodies[0]).not.toHaveProperty("signal");
  });

  test("an already-aborted caller reaches zero simulated coordinator work", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped before dispatch", "AbortError"));
    let work = 0;
    const namespace = {
      getByName(_name: string) {
        return {
          async fetch(_input: RequestInfo | URL, init?: RequestInit) {
            if (!init?.signal?.aborted) work++;
            init?.signal?.throwIfAborted();
            throw new Error("Aborted caller must not run provider work");
          },
        };
      },
    };
    await expect(
      sharedRestMessageSend(
        agent,
        "room-fixture",
        "hello",
        "Eliza",
        executionCtx,
        namespace,
        "preaborted-message",
        "platform",
        undefined,
        "hello",
        undefined,
        accountState,
        "preaborted-trace",
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(work).toBe(0);
  });
});
