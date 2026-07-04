/**
 * Exercises `connectAccountAction` (validate + handler): matching
 * add / connect-another-account intents while rejecting lookalikes (bare
 * add/connect verbs or account references without an add intent), and stamping
 * the `accountConnect` provider offer — Claude subscription, OpenAI Codex, or
 * both — onto the callback Content and the returned ActionResult. Deterministic:
 * empty runtime/state, no OAuth flow or network.
 */
import type {
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { connectAccountAction } from "./connect-account.ts";

/** Shape of the `accountConnect` field the action stamps on Content / result. */
interface AccountConnectPayload {
  providers: string[];
  reason?: string;
}

/** Read the (dynamically-typed) `accountConnect` field off a Content object. */
function readAccountConnect(
  content: Content | undefined,
): AccountConnectPayload | undefined {
  return content?.accountConnect as AccountConnectPayload | undefined;
}

const runtime = {} as IAgentRuntime;
const state = {} as State;

function messageWith(text: string): Memory {
  return { content: { text } } as unknown as Memory;
}

async function runValidate(text: string): Promise<boolean> {
  return (
    (await connectAccountAction.validate?.(
      runtime,
      messageWith(text),
      state,
    )) ?? false
  );
}

async function runHandler(text: string): Promise<{
  callbacks: Content[];
  result: ActionResult;
}> {
  const callbacks: Content[] = [];
  const callback: HandlerCallback = async (content) => {
    callbacks.push(content);
    return [];
  };
  const result = await connectAccountAction.handler(
    runtime,
    messageWith(text),
    state,
    undefined,
    callback,
  );
  if (!result || typeof result !== "object") {
    throw new Error("CONNECT_ACCOUNT handler returned no ActionResult");
  }
  return { callbacks, result };
}

describe("CONNECT_ACCOUNT validate", () => {
  it("matches add/connect-another-account intents", async () => {
    const intents = [
      "add another claude account",
      "connect a second codex account",
      "log into another account",
      "add an account",
      "sign in with a different account",
      "I want to link a new anthropic account",
      "hook up another openai account please",
    ];
    for (const text of intents) {
      expect(await runValidate(text)).toBe(true);
    }
  });

  it("rejects unrelated text (no add-account intent)", async () => {
    const nonIntents = [
      "what's the weather today",
      "add a reminder for tomorrow", // add verb, but no account anchor
      "connect me to the wifi", // connect verb, but no account anchor
      "delete my claude account", // account anchor, but not an add intent
      "which account am I using", // account anchor, no add verb
      "",
      "   ",
    ];
    for (const text of nonIntents) {
      expect(await runValidate(text)).toBe(false);
    }
  });
});

describe("CONNECT_ACCOUNT handler", () => {
  it("offers only Claude when the user names claude", async () => {
    const { callbacks, result } = await runHandler(
      "add another claude account",
    );
    expect(result.success).toBe(true);
    expect(readAccountConnect(callbacks.at(0))).toEqual({
      providers: ["anthropic-subscription"],
      reason: expect.stringContaining("Claude Subscription"),
    });
    // The structured field is also mirrored on the ActionResult data.
    expect(
      (result.data as { accountConnect?: AccountConnectPayload })
        ?.accountConnect?.providers,
    ).toEqual(["anthropic-subscription"]);
  });

  it("offers only Codex when the user names codex", async () => {
    const { callbacks } = await runHandler("connect a second codex account");
    expect(readAccountConnect(callbacks.at(0))).toEqual({
      providers: ["openai-codex"],
      reason: expect.any(String),
    });
  });

  it("offers both providers when unspecified", async () => {
    const { callbacks, result } = await runHandler("log into another account");
    expect(readAccountConnect(callbacks.at(0))?.providers).toEqual([
      "anthropic-subscription",
      "openai-codex",
    ]);
    expect(result.success).toBe(true);
  });

  it("returns a friendly reply telling the user to pick a provider", async () => {
    const { callbacks } = await runHandler("add an account");
    const cb = callbacks.at(0);
    expect(typeof cb?.text).toBe("string");
    expect(cb?.text).toMatch(/pick a provider/i);
    expect(cb?.action).toBe("CONNECT_ACCOUNT");
  });
});
