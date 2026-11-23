// spec/maps/relay.md, "Story: Navigate again when the phone never received my request"
import { Effect, Fiber } from "effect";
import type { Driver, Options } from "../../gen/maps__relay.conformance.ts";
import type { MapsRelay } from "../../gen/maps__relay.ts";
import { mapsNavigationRelay, type MapsNavigationRelay, type RelayReply } from "../../src/relay.vibe";
import { until } from "../support/gates.ts";

interface View {
  readonly phase: MapsRelay["phase"];
  readonly command: number;
  readonly deliveries: number;
  readonly receipts: number;
  readonly hasOffer: boolean;
  readonly leaseIsCurrent: boolean;
}

const view = (s: MapsRelay): View => ({
  phase: s.phase, command: s.command, deliveries: s.deliveries, receipts: s.receipts, hasOffer: s.offer > 0,
  leaseIsCurrent: s.phase !== "Leased" || s.leasedTo === s.offer,
});

const conversationId = "11111111-2222-4333-8444-555555555555";
const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-2222-4333-8444-555555555555`;

interface Host {
  readonly relay: MapsNavigationRelay;
  offer?: string;
  offers: number;
  modelOffer: number;
  active: boolean;
  ran: boolean;
  request?: RelayReply["request"];
  waiting?: Fiber.Fiber<unknown, unknown>;
}

const hosts = new Map<string, Host>();

function host(key: string): Host {
  const known = hosts.get(key);
  if (known !== undefined) return known;
  const made: Host = { relay: Effect.runSync(mapsNavigationRelay({ leaseMs: 0, commandMs: 600_000, liveMs: 600_000, idleMs: 600_000, pollMs: 2 })), offers: 0, modelOffer: 0, active: true, ran: false };
  hosts.set(key, made);
  return made;
}

const message = (owner: Host, phase: string, extra: Record<string, unknown> = {}) => ({ phase, conversationId, offerId: owner.offer ?? uuid(0), ...extra });

export const driver: Driver<View> = {
  reset() {
    for (const owner of hosts.values()) if (owner.waiting !== undefined) Effect.runFork(Fiber.interrupt(owner.waiting));
    hosts.clear();
  },
  async dispatch(key, event) {
    const owner = host(key);
    const before = await Effect.runPromise(owner.relay.state(key));
    const outstanding = before.phase === "Queued" || before.phase === "Leased";
    switch (event.type) {
      case "openOffer": {
        if (!(event.offer > owner.modelOffer)) return "refused";
        owner.modelOffer = event.offer;
        owner.offers += 1;
        owner.offer = uuid(owner.offers);
        owner.ran = false;
        await Effect.runPromise(owner.relay.handle(key, message(owner, "open")));
        return "accepted";
      }
      case "queueCommand": {
        if (before.offer <= 0 || outstanding) return "refused";
        owner.waiting = Effect.runFork(Effect.exit(owner.relay.navigation(key, conversationId, () => owner.active).stop()));
        owner.ran = false;
        await until(async () => (await Effect.runPromise(owner.relay.state(key))).phase === "Queued");
        return "accepted";
      }
      case "deliverCommand":
      case "redeliverCommand": {
        const allowed = event.type === "deliverCommand" ? before.phase === "Queued" && before.offer > 0 : before.phase === "Leased" && before.deliveries < 3;
        if (!allowed) return "refused";
        const reply = await Effect.runPromise(owner.relay.handle(key, message(owner, "poll")));
        owner.request = reply.request;
        return "accepted";
      }
      case "phoneRuns": {
        if (before.phase !== "Leased" || before.leasedTo !== before.offer) return "refused";
        owner.ran = true;
        return "accepted";
      }
      case "receiptArrives": {
        if (before.phase !== "Leased" || !owner.ran || before.receipts !== 0 || owner.request == null) return "refused";
        await Effect.runPromise(owner.relay.handle(key, message(owner, "result", { id: owner.request.id, status: { state: "stopped" } })));
        return "accepted";
      }
      case "abandonCommand": {
        if (!outstanding) return "refused";
        owner.active = false;
        await Effect.runPromise(Effect.exit(owner.relay.handle(key, message(owner, "poll"))));
        owner.active = true;
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: async (key) => view(await Effect.runPromise(host(key).relay.state(key))),
};

export const options: Options<View> = { view, keys: ["phone"] };
