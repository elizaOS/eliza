/**
 * Regression test for the Timeline dispatch guard: the real matrix-js-sdk sync
 * loop replays the initial /sync history as RoomEvent.Timeline events before
 * PREPARED, and the service must not hand those to the agent on any boot, while
 * a live event that arrives after PREPARED is dispatched exactly once (#31765).
 * Real SDK client over a scripted fetch; no homeserver.
 */

import type { IAgentRuntime } from "@elizaos/core";
import * as sdk from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { MatrixService } from "../service.js";

const ROOM = "!ops:example";
const BOT = "@bot:example";
const ALICE = "@alice:example";

function initialSync() {
  const member = (uid: string) => ({
    type: "m.room.member",
    state_key: uid,
    sender: uid,
    event_id: `$m-${uid}`,
    origin_server_ts: 1,
    content: { membership: "join", displayname: uid },
  });
  const msg = (n: number) => ({
    type: "m.room.message",
    sender: ALICE,
    event_id: `$hist-${n}`,
    origin_server_ts: 1000 + n,
    content: { msgtype: "m.text", body: `history ${n}` },
  });
  return {
    next_batch: "s1",
    presence: { events: [] },
    account_data: { events: [] },
    to_device: { events: [] },
    rooms: {
      join: {
        [ROOM]: {
          state: {
            events: [
              {
                type: "m.room.create",
                state_key: "",
                sender: ALICE,
                event_id: "$create",
                origin_server_ts: 0,
                content: { creator: ALICE },
              },
              member(ALICE),
              member(BOT),
            ],
          },
          timeline: { events: [msg(1), msg(2), msg(3)], limited: true, prev_batch: "p0" },
          ephemeral: { events: [] },
          account_data: { events: [] },
          unread_notifications: {},
        },
      },
      invite: {},
      leave: {},
    },
  };
}

function makeFetch(seen: string[], liveEvent?: Record<string, unknown>) {
  let liveServed = false;
  return async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    seen.push(url.pathname + (url.searchParams.has("since") ? "?since" : ""));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.pathname.endsWith("/versions"))
      return json({ versions: ["v1.11"], unstable_features: {} });
    if (url.pathname.endsWith("/pushrules/"))
      return json({ global: { override: [], content: [], room: [], sender: [], underride: [] } });
    if (url.pathname.endsWith("/capabilities")) return json({ capabilities: {} });
    if (url.pathname.includes("/filter")) return json({ filter_id: "f1" });
    if (url.pathname.endsWith("/sync")) {
      if (url.searchParams.has("since")) {
        if (liveEvent && !liveServed) {
          liveServed = true;
          return json({
            next_batch: "s2",
            presence: { events: [] },
            account_data: { events: [] },
            to_device: { events: [] },
            rooms: {
              join: {
                [ROOM]: {
                  state: { events: [] },
                  timeline: { events: [liveEvent], limited: false, prev_batch: "p2" },
                  ephemeral: { events: [] },
                  account_data: { events: [] },
                },
              },
              invite: {},
              leave: {},
            },
          });
        }
        return new Promise<Response>(() => {}); // steady-state long poll, never resolves
      }
      return json(initialSync());
    }
    return json({});
  };
}

async function bootOnce(label: string, liveEvent?: Record<string, unknown>) {
  const seen: string[] = [];
  const client = sdk.createClient({
    baseUrl: "https://matrix.example",
    userId: BOT,
    accessToken: "tok",
    deviceId: "DEV",
    fetchFn: makeFetch(seen, liveEvent) as typeof fetch,
  });
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
  const service = Object.create(MatrixService.prototype) as MatrixService;
  Object.assign(service, { runtime, defaultAccountId: "work" });
  const dispatched: string[] = [];
  (
    service as unknown as {
      handleRoomMessage: (s: unknown, e: sdk.MatrixEvent, r: unknown) => void;
    }
  ).handleRoomMessage = (_s, e) => {
    dispatched.push(e.getId() ?? "?");
  };
  const state = {
    accountId: "work",
    settings: { userId: BOT, autoJoin: false, verifyAllowlist: [], requireMention: false },
    client,
    connected: false,
    syncing: false,
  };
  (service as unknown as { setupEventHandlers: (s: unknown) => void }).setupEventHandlers(state);
  const prepared = new Promise<void>((resolve) => {
    client.on(sdk.ClientEvent.Sync, (s) => {
      if (s === "PREPARED") resolve();
    });
  });
  await client.startClient({ initialSyncLimit: 10 });
  await prepared;
  await new Promise((r) => setTimeout(r, liveEvent ? 300 : 50));
  client.stopClient();
  void label;
  return dispatched;
}

describe("matrix initial-sync replay guard", () => {
  it("dispatches nothing from the initial sync on a first boot or a restart", async () => {
    const first = await bootOnce("boot-1");
    const second = await bootOnce("boot-2 (restart)");
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  }, 20_000);

  it("dispatches a live event that arrives after PREPARED exactly once", async () => {
    const dispatched = await bootOnce("boot-live", {
      type: "m.room.message",
      sender: ALICE,
      event_id: "$live-1",
      origin_server_ts: 5000,
      content: { msgtype: "m.text", body: "live" },
    });
    expect(dispatched).toEqual(["$live-1"]);
  }, 20_000);
});
