import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { NetworkServiceClient } from "./backend/client.js";
import { RELAY_PATH, type RelaySendRequest } from "./backend/contract.js";
import { createServiceNetworkStore } from "./backend/service-store.js";
import { svcVerify } from "./backend/svc-auth.js";
import { createNetworkEdgePlugin } from "./edge.js";
import { InMemoryNetworkStore } from "./memory-store.js";
import { networkAgentVoice } from "./providers/agent-voice.js";

const SECRET = "s".repeat(40);
const runtime = {} as IAgentRuntime;

function serviceSetup(response: unknown) {
  const calls: Array<{ path: string; body: RelaySendRequest; ok: boolean }> =
    [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    const verified = await svcVerify(SECRET, {
      method: "POST",
      path,
      headers,
      body,
    });
    calls.push({ path, body: JSON.parse(body), ok: verified.ok });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new NetworkServiceClient({
    baseUrl: "https://network.test",
    secret: SECRET,
    fetch: fetchImpl,
  });
  const store = createServiceNetworkStore(client, {
    channel: "blooio",
    app: "slop",
    memberId: "svc-member-1",
    messageId: "msg_1",
    context: {
      firstName: "Ana",
      city: "NYC",
      state: "open",
      stateFrom: null,
      stateUntil: null,
      facets: [],
      activeItems: [{ id: "opp_7", kind: "intro", summary: "Intro to Sam" }],
      singlePlayer: false,
    },
  });
  return { calls, store };
}

function relayAction(store: ReturnType<typeof serviceSetup>["store"]) {
  const plugin = createNetworkEdgePlugin({
    store,
    authority: { memberId: "cloud-user-1" },
  });
  const action = plugin.actions?.find((a) => a.name === "RELAY");
  assert(action, "RELAY registered for a service-backed store");
  return action;
}

const message = (text: string) =>
  ({ id: "mem-1", content: { text } }) as unknown as Memory;

describe("RELAY action", () => {
  it("sends the member's own words, signed, with the service's turn identity", async () => {
    const { calls, store } = serviceSetup({
      decision: "pass",
      senderNotice: "Sent to Sam.",
      delivered: true,
      replayed: false,
    });
    const result = await relayAction(store).handler(
      runtime,
      message("tell Sam I'm running 10 minutes late"),
      undefined,
      { parameters: { itemId: "opp_7" } } as unknown as HandlerOptions,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, RELAY_PATH);
    assert.equal(calls[0].ok, true);
    assert.deepEqual(calls[0].body, {
      channel: "blooio",
      messageId: "msg_1",
      app: "slop",
      memberId: "svc-member-1",
      itemId: "opp_7",
      text: "tell Sam I'm running 10 minutes late",
    });
    assert.equal(result?.success, true);
    assert.equal(result?.text, "Sent to Sam.");
  });

  it("drops an item id the turn did not offer and reports held items as not sent", async () => {
    const { calls, store } = serviceSetup({
      decision: "hold",
      senderNotice: "I'll check that before passing it on.",
      delivered: false,
      replayed: false,
    });
    const result = await relayAction(store).handler(
      runtime,
      message("tell her my address is 5 Main St"),
      undefined,
      {
        parameters: { itemId: "opp_someone_else" },
      } as unknown as HandlerOptions,
    );
    assert.equal(calls[0].body.itemId, null);
    assert.equal(result?.success, false);
    assert.equal(result?.data?.delivered, false);
  });

  it("does not report a passed classifier result as delivered without a receipt", async () => {
    const { store } = serviceSetup({
      decision: "pass",
      senderNotice: "Sent.",
      delivered: false,
      replayed: false,
    });
    const result = await relayAction(store).handler(
      runtime,
      message("tell Sam I am late"),
    );
    assert.equal(result?.success, false);
    assert.equal(result?.error, "delivery_unconfirmed");
    assert.equal(result?.data?.delivered, false);
  });

  it("rejects malformed or contradictory service receipts", async () => {
    for (const response of [
      null,
      {},
      {
        decision: "pass",
        senderNotice: "Sent.",
        delivered: "true",
        replayed: false,
      },
      {
        decision: "block",
        senderNotice: "Blocked",
        delivered: true,
        replayed: false,
      },
    ]) {
      const { store } = serviceSetup(response);
      await assert.rejects(
        () =>
          relayAction(store).handler(runtime, message("tell Sam I am late")),
        /invalid relay receipt/,
      );
    }
  });

  it("is not offered when the store cannot relay", () => {
    const plugin = createNetworkEdgePlugin({
      store: new InMemoryNetworkStore(),
      authority: { memberId: "m" },
    });
    assert(!plugin.actions?.some((a) => a.name === "RELAY"));
  });
});

describe("Network voice (character flag)", () => {
  it("is off unless the host passes voice", () => {
    const store = new InMemoryNetworkStore();
    const off = createNetworkEdgePlugin({
      store,
      authority: { memberId: "m" },
    });
    assert(!off.providers?.some((p) => p.name === "NETWORK_VOICE"));
    const on = createNetworkEdgePlugin({
      store,
      authority: { memberId: "m" },
      voice: { app: "slop" },
    });
    assert(on.providers?.some((p) => p.name === "NETWORK_VOICE"));
  });

  it("names Eliza and the app's agent role", () => {
    const slop = networkAgentVoice("slop");
    assert.match(slop, /You are Eliza/);
    assert.match(slop, /slop's matchmaker/);
    assert.match(networkAgentVoice("ntwrk"), /the Network's agent/);
    assert.match(networkAgentVoice("friends"), /friends\.help's planner/);
    assert.match(networkAgentVoice("peon"), /peon's recruiter/);
  });
});
