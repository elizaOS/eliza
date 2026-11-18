import { expect, it } from "vitest";
import * as M from "../gen/agent__access__transport.ts";
import { driver, options } from "./drivers/agent__access__transport.ts";

const inbounds: M.Inbound[] = [{ tag: "Unreadable" }, { tag: "EventsSubscribe" }, { tag: "HttpRequest", route: "PlainRoute", bodyBytes: 512 }, { tag: "HttpRequest", route: "PlainRoute", bodyBytes: 3000000 }, { tag: "HttpRequest", route: "MessageRoute", bodyBytes: 3000000 }, { tag: "HttpRequestStream", route: "SpeechRoute", bodyBytes: 512 }, { tag: "HttpRequestStream", route: "PlainRoute", bodyBytes: 3000000 }];
const events: M.Event[] = [
  ...(["PrivateSocket", "LoopbackHttp", "OtherAddress"] as const).map((address) => ({ type: "listen", address }) as M.Event),
  { type: "close" }, { type: "releaseNext", ok: true }, { type: "releaseNext", ok: false },
  ...[1, 2, 3].flatMap((conn) => [
    { type: "accept", conn }, ...inbounds.map((inbound) => ({ type: "receive", conn, inbound })),
    { type: "respond", conn, status: 200 }, { type: "respond", conn, status: 404 }, { type: "handlerFails", conn }, { type: "expire", conn },
    { type: "peerClose", conn }, { type: "sendHead", conn, status: 200 }, { type: "sendChunk", conn }, { type: "complete", conn },
    { type: "publish", conn }, { type: "drop", conn },
  ] as M.Event[]),
];
let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

it("driver agrees with the model on random walks", async () => {
  for (let walk = 0; walk < 300; walk++) {
    await driver.reset();
    let state = M.initial;
    for (let i = 0; i < 25; i++) {
      const allowed = events.filter((e) => M.enabled(state, e));
      const pool = allowed.length && random() < 0.8 ? allowed : events;
      const event = pool[Math.floor(random() * pool.length)];
      const expected = M.enabled(state, event) ? "accepted" : "refused";
      const wire = M.step(state, event);
      const got = await driver.dispatch("listener", event);
      const ctx = JSON.stringify({ walk, i, event });
      expect(got, ctx).toBe(expected);
      expect(await driver.observe("listener"), ctx).toEqual(options.view!(wire.state));
      expect(await driver.observeOutput!("listener"), ctx).toEqual(expected === "accepted" ? wire.out : []);
      state = wire.state;
    }
  }
});
