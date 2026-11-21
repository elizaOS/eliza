/**
 * "show my contacts" on the Pixel (v612, 2026-11-19) replied "I couldn't load
 * your contacts this time. Give it another try and it should work." agent.log:
 * the turn's first Stage-1 model request failed with "read ECONNRESET" before
 * any response arrived ("v5 message runtime failed", failureCause=transient),
 * so no contacts read, Contacts navigation or device action ever ran. The
 * structured failure path then asked a model for an apology, and that model
 * invented the cause from the user's words and promised the retry would work.
 */
import {
  buildFailureReplyPrompt,
  type IAgentRuntime,
  isModelConnectionError,
  ModelType,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  makeState,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.ts";
import { CONNECTION_FAILED_REPLY, MessageFailures } from "./failures.ts";

const STAGE = "running the native tool message runtime";
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as never;
const IMPROVISED =
  "I couldn't load your contacts this time. Give it another try and it should work.";

/** The error Bun's node:net raises for a reset socket (probed on Bun 1.4.2). */
function connectionReset(): Error {
  return Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
}

function textRuntime(responses: unknown[]): IAgentRuntime {
  const runtime = makeRuntime(responses);
  (runtime as { getModel: unknown }).getModel = vi.fn((type: string) =>
    type === ModelType.TEXT_LARGE ? vi.fn() : undefined,
  );
  return runtime;
}

function build(runtime: IAgentRuntime, error: unknown) {
  return new MessageFailures().buildStructuredFailureReply(
    runtime,
    makeMessage({ text: "show my contacts" }),
    makeState(),
    RESPONSE_ID,
    STAGE,
    "transient",
    error,
  );
}

describe("a turn whose model connection dropped", () => {
  it("says the connection failed instead of improvising a cause", async () => {
    const runtime = textRuntime([IMPROVISED]);
    const result = await build(runtime, connectionReset());
    expect(result.responseContent).toMatchObject({
      text: CONNECTION_FAILED_REPLY,
      actions: ["REPLY"],
      failureKind: "transient_failure",
      transient: true,
      doNotPersist: true,
    });
    expect(result.responseContent?.text).not.toMatch(/contact/i);
    expect(result.terminalFailure).toMatchObject({
      kind: "transient_failure",
      transient: true,
      message: CONNECTION_FAILED_REPLY,
    });
    // No apology model call that could name app data or promise success.
    expect(useModelCalls(runtime)).toHaveLength(0);
  });

  it("recognizes the reset when a provider wraps it in a cause", async () => {
    const wrapped = Object.assign(new Error("Cannot connect to API"), {
      name: "AI_APICallError",
      cause: connectionReset(),
    });
    const result = await build(textRuntime([IMPROVISED]), wrapped);
    expect(result.responseContent?.text).toBe(CONNECTION_FAILED_REPLY);
  });

  it("uses the character's own connection reply when it has one", async () => {
    const runtime = textRuntime([IMPROVISED]);
    runtime.character.templates = {
      connectionFailedReply: "Lost my connection. Try that again.",
    };
    const result = await build(runtime, connectionReset());
    expect(result.responseContent?.text).toBe(
      "Lost my connection. Try that again.",
    );
  });

  it("keeps the rate-limit reply for a 429 that did arrive", async () => {
    const tooMany = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    const result = await build(textRuntime([IMPROVISED]), tooMany);
    expect(result.responseContent).toMatchObject({
      failureKind: "rate_limited",
      transient: true,
    });
    expect(result.responseContent?.text).not.toBe(CONNECTION_FAILED_REPLY);
  });

  it("leaves other transient failures to the grounded apology prompt", async () => {
    const runtime = textRuntime(["Something went wrong. Try again."]);
    const result = await build(runtime, new Error("unexpected planner state"));
    expect(result.responseContent?.text).toBe(
      "Something went wrong. Try again.",
    );
    expect(useModelCalls(runtime)).toHaveLength(1);
  });
});

describe("isModelConnectionError", () => {
  it("is structural: codes through causes, never a received HTTP status", () => {
    expect(isModelConnectionError(connectionReset())).toBe(true);
    expect(
      isModelConnectionError(
        Object.assign(new Error("Unable to connect"), {
          code: "ConnectionRefused",
        }),
      ),
    ).toBe(true);
    expect(isModelConnectionError(new Error("read ECONNRESET"))).toBe(false);
    expect(
      isModelConnectionError(
        Object.assign(new Error("Bad Gateway"), {
          status: 502,
          cause: connectionReset(),
        }),
      ),
    ).toBe(false);
  });
});

describe("the transient apology prompt", () => {
  it("forbids naming app data as the failure or promising the retry", () => {
    const prompt = buildFailureReplyPrompt("user: show my contacts");
    expect(prompt).toContain("You do not know which step failed");
    expect(prompt).toMatch(/such as contacts/);
    expect(prompt).toContain("do not promise that a retry will work");
  });
});
