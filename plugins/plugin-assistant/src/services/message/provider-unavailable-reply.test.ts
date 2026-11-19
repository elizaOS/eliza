/**
 * "find the nearest pharmacy" on the Pixel (v612, 2026-11-18) replied
 * "Something went wrong on my end, so I wasn't able to find a pharmacy for
 * you. Could you try again?". No Maps reply reached the chat, and the next
 * turn failed the same way while AI rate-limit replies came and went: the
 * model provider had not answered. A provider that stops answering (its own
 * retry budget spent, or a server, timeout or network failure) is not a
 * 429, so the failure reply asked another model call for an apology, and the
 * transient instruction made it "something went wrong on my end". The reply
 * now names the unavailable service and offers a retry, without a model call.
 */
import {
  ElizaError,
  MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  makeMessage,
  makeRuntime,
  makeState,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.ts";
import {
  CONNECTION_FAILED_REPLY,
  MessageFailures,
  PROVIDER_UNAVAILABLE_REPLY,
} from "./failures.ts";

const STAGE = "running the native tool message runtime";
const responseId = "00000000-0000-0000-0000-000000000612" as never;

async function reply(error: unknown) {
  // A text model is registered, so the reply is not the missing-provider hint.
  const runtime = Object.assign(makeRuntime(["Sorry, I couldn't do that."]), {
    getModel: () => async () => "",
  });
  const result = await new MessageFailures().buildStructuredFailureReply(
    runtime,
    makeMessage({ text: "find the nearest pharmacy" }),
    makeState(),
    responseId,
    STAGE,
    "transient",
    error,
  );
  return { runtime, result };
}

describe("a model provider that did not answer the turn", () => {
  it.each([
    [
      "the Cloud gateway's retry budget",
      new ElizaError(
        "elizaOS Cloud gateway remained unavailable after transient retries",
        {
          code: MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED,
          severity: "ephemeral",
        },
      ),
    ],
    [
      "a 503 from the provider",
      Object.assign(new Error("Service Unavailable"), { status: 503 }),
    ],
  ])("says the AI service did not respond after %s", async (_name, error) => {
    const { runtime, result } = await reply(error);
    expect(result.responseContent).toMatchObject({
      text: PROVIDER_UNAVAILABLE_REPLY,
      actions: ["REPLY"],
      transient: true,
      failureKind: "transient_failure",
      doNotPersist: true,
    });
    expect(result.responseContent?.text).not.toMatch(/went wrong/i);
    expect(result.responseContent?.text).toMatch(/try again/i);
    // No apology model call that could blur the cause.
    expect(useModelCalls(runtime)).toHaveLength(0);
  });

  // A dropped connection is named as one (failures.connection.test.ts), with
  // the persona's own dropped-connection reply, not as a service that did not
  // respond. It is still a transient failure, so clients see provider_issue.
  it("says a dropped connection failed, even inside a fetch error", async () => {
    const { runtime, result } = await reply(
      Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        }),
      }),
    );
    expect(result.responseContent).toMatchObject({
      text: CONNECTION_FAILED_REPLY,
      actions: ["REPLY"],
      transient: true,
      failureKind: "transient_failure",
      doNotPersist: true,
    });
    expect(useModelCalls(runtime)).toHaveLength(0);
  });

  it("keeps the rate-limit reply for a 429", async () => {
    const { result } = await reply(
      Object.assign(new Error("Too Many Requests"), { status: 429 }),
    );
    expect(result.responseContent?.text).toMatch(/rate-limiting/);
    expect(result.responseContent).toMatchObject({
      failureKind: "rate_limited",
      transient: true,
    });
  });

  it("still asks for an in-character apology when the cause is not the provider", async () => {
    const { runtime } = await reply(new Error("unexpected state"));
    expect(useModelCalls(runtime).length).toBeGreaterThan(0);
  });
});
