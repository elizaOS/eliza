/**
 * Cloud account action suite (CLOUD_ACCOUNT_STATUS / CLOUD_LIST_AGENTS /
 * CLOUD_CREATE_API_KEY) — real SDK over the loopback cloud server: validate
 * gating on the signed-in state, handler re-guards, honest empty/error paths,
 * the session-only 401/403 fallback for key creation, the reserved-name
 * refusal, and the show-plain-key-once contract.
 */

import type { Content, HandlerCallback, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudAccountStatusAction } from "../../src/actions/cloud-account-status";
import { createCloudApiKeyAction, parseApiKeyName } from "../../src/actions/create-cloud-api-key";
import { listCloudAgentsAction } from "../../src/actions/list-cloud-agents";
import { type CloudServer, makeRuntime, startCloudServer } from "./cloud-account-harness";

const STATE = {} as State;

function message(text: string): Memory {
  return { content: { text } } as Memory;
}

function collectCallback(): { replies: Content[]; callback: HandlerCallback } {
  const replies: Content[] = [];
  const callback: HandlerCallback = async (content) => {
    replies.push(content);
    return [];
  };
  return { replies, callback };
}

let server: CloudServer;

beforeEach(async () => {
  server = await startCloudServer();
});

afterEach(async () => {
  await server.close();
});

describe("validate gating (signed-out actions vanish from the planner)", () => {
  for (const action of [cloudAccountStatusAction, listCloudAgentsAction, createCloudApiKeyAction]) {
    it(`${action.name} validates only when cloud-authenticated`, async () => {
      const signedIn = makeRuntime({ baseUrl: server.url });
      const signedOut = makeRuntime({ baseUrl: server.url, authenticated: false });
      await expect(action.validate?.(signedIn, message("hi"), STATE)).resolves.toBe(true);
      await expect(action.validate?.(signedOut, message("hi"), STATE)).resolves.toBe(false);
    });
  }
});

describe("CLOUD_ACCOUNT_STATUS", () => {
  it("replies with the fresh balance", async () => {
    const runtime = makeRuntime({ baseUrl: server.url });
    const { replies, callback } = collectCallback();
    const result = await cloudAccountStatusAction.handler(
      runtime,
      message("how many credits do I have?"),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(true);
    expect(replies[0]?.text).toContain("$12.34");
    expect(result.data).toMatchObject({ balance: 12.34, low: false, critical: false });
  });

  it("warns and links the top-up page on a critical balance", async () => {
    server.state.balance = 0.1;
    const runtime = makeRuntime({ baseUrl: server.url });
    const { replies, callback } = collectCallback();
    const result = await cloudAccountStatusAction.handler(
      runtime,
      message("cloud balance?"),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(true);
    expect(replies[0]?.text).toContain("critically low");
    expect(replies[0]?.text).toContain("dashboard/settings?tab=billing");
  });

  it("re-guards in the handler when signed out (validate is advisory)", async () => {
    const runtime = makeRuntime({ baseUrl: server.url, authenticated: false });
    const { replies, callback } = collectCallback();
    const result = await cloudAccountStatusAction.handler(
      runtime,
      message("balance?"),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ reason: "not_connected" });
    expect(replies[0]?.text).toContain("not connected to Eliza Cloud");
    expect(server.state.requests).toEqual([]);
  });

  it("returns an honest failure when the cloud API errors", async () => {
    server.state.failBalance = true;
    const runtime = makeRuntime({ baseUrl: server.url });
    const { callback } = collectCallback();
    const result = await cloudAccountStatusAction.handler(
      runtime,
      message("balance?"),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ reason: "error" });
  });
});

describe("CLOUD_LIST_AGENTS", () => {
  it("lists hosted agents with statuses", async () => {
    const runtime = makeRuntime({ baseUrl: server.url });
    const { replies, callback } = collectCallback();
    const result = await listCloudAgentsAction.handler(
      runtime,
      message("what agents do I have?"),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(true);
    expect(replies[0]?.text).toContain("2 agents hosted on Eliza Cloud");
    expect(replies[0]?.text).toContain("• alpha — running");
    expect(replies[0]?.text).toContain("• beta — stopped");
  });

  it("renders the designed empty state when there are no agents", async () => {
    server.state.agents = [];
    const runtime = makeRuntime({ baseUrl: server.url });
    const { replies, callback } = collectCallback();
    const result = await listCloudAgentsAction.handler(
      runtime,
      message("my hosted agents"),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ count: 0 });
    expect(replies[0]?.text).toContain("don't have any agents hosted");
  });

  it("fails honestly on a cloud API error", async () => {
    server.state.failAgents = true;
    const runtime = makeRuntime({ baseUrl: server.url });
    const { callback } = collectCallback();
    const result = await listCloudAgentsAction.handler(
      runtime,
      message("my agents"),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ reason: "error" });
  });
});

describe("parseApiKeyName", () => {
  const NOW = new Date("2026-07-06T12:00:00.000Z");

  it("prefers a quoted name", () => {
    expect(parseApiKeyName('create a key called "ci-deploys"', NOW)).toBe("ci-deploys");
  });

  it("falls back to the word after named/called", () => {
    expect(parseApiKeyName("make an api key named staging-bot", NOW)).toBe("staging-bot");
  });

  it("defaults to a dated name", () => {
    expect(parseApiKeyName("make me a cloud api key", NOW)).toBe("agent-created-2026-07-06");
  });
});

describe("CLOUD_CREATE_API_KEY", () => {
  it("creates a key and surfaces the plain key exactly once (reply only)", async () => {
    const runtime = makeRuntime({ baseUrl: server.url });
    const { replies, callback } = collectCallback();
    const result = await createCloudApiKeyAction.handler(
      runtime,
      message('create a cloud api key called "ci-deploys"'),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(true);
    expect(server.state.lastCreateKeyBody).toMatchObject({ name: "ci-deploys" });
    // The plain key transits the user reply once…
    expect(replies[0]?.text).toContain("eliza_plain_key_shown_once");
    expect(replies[0]?.text).toContain("only time");
    // …and never the durable action result.
    expect(JSON.stringify(result.data)).not.toContain("eliza_plain_key_shown_once");
    expect(result.text).not.toContain("eliza_plain_key_shown_once");
  });

  it("redirects to a signed-in session when the route rejects the agent key", async () => {
    server.state.createKeyStatus = 403;
    const runtime = makeRuntime({ baseUrl: server.url });
    const { replies, callback } = collectCallback();
    const result = await createCloudApiKeyAction.handler(
      runtime,
      message("make a new api key"),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ reason: "session_required" });
    expect(replies[0]?.text).toContain("signed-in session");
    expect(replies[0]?.text).toContain("Cloud app");
  });

  it("refuses the reserved agent-sandbox: prefix without any network call", async () => {
    const runtime = makeRuntime({ baseUrl: server.url });
    const { replies, callback } = collectCallback();
    const result = await createCloudApiKeyAction.handler(
      runtime,
      message('create a key called "agent-sandbox:sneaky"'),
      STATE,
      undefined,
      callback
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ reason: "reserved_name" });
    expect(replies[0]?.text).toContain("reserved");
    expect(server.state.requests).toEqual([]);
  });
});
