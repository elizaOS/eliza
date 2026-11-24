// spec/maps/requests.md, "Story: Back off when Maps asks me to wait"
import { Clock, Effect, Exit, Fiber } from "effect";
import type { Driver, Options } from "../../gen/maps__requests.conformance.ts";
import type { MapRequests } from "../../gen/maps__requests.ts";
import { cloudMaps, type CloudMaps } from "@elizaos/plugin-maps-client";
import type { MapsProvider } from "@elizaos/plugin-maps-client";
import { cloudFailure, heldCloud, manualClock } from "../support/cloud.ts";
import { until } from "../support/gates.ts";

type View = Omit<MapRequests, "lastReply">;
const view = ({ lastReply: _reply, ...rest }: MapRequests): View => rest;

interface Phone {
  readonly maps: CloudMaps;
  readonly cloud: ReturnType<typeof heldCloud>;
  readonly clock: ReturnType<typeof manualClock>;
  readonly searches: Array<{ readonly fiber: Fiber.Fiber<unknown, unknown>; readonly index: number }>;
  provider?: MapsProvider;
  account: number;
}

const phones = new Map<string, Phone>();
const on = <A, E>(owner: Phone, work: Effect.Effect<A, E>) => Effect.provideService(work, Clock.Clock, owner.clock.clock);

async function connect(owner: Phone): Promise<void> {
  owner.account += 1;
  await Effect.runPromise(on(owner, owner.maps.bind({ session: `s${owner.account}`, credential: `k${owner.account}`, client: owner.cloud.client })));
  await Effect.runPromise(on(owner, owner.maps.initialize(true)));
}

async function phone(key: string): Promise<Phone> {
  const known = phones.get(key);
  if (known !== undefined) return known;
  const made = { cloud: heldCloud(true), clock: manualClock(), searches: [], account: 0 } as unknown as Phone;
  (made as { maps: CloudMaps }).maps = Effect.runSync(cloudMaps((_config, provider) => { made.provider = provider; }));
  phones.set(key, made);
  await connect(made);
  return made;
}

export const driver: Driver<View> = {
  reset() {
    phones.clear();
  },
  async dispatch(key, event) {
    const owner = await phone(key);
    const before = await Effect.runPromise(on(owner, owner.maps.requests()));
    switch (event.type) {
      case "request": {
        const provider = owner.provider;
        if (before.now < before.until || provider === undefined) return "refused";
        const index = owner.cloud.searches.length;
        owner.searches.push({ fiber: Effect.runFork(on(owner, provider.search("pharmacy"))), index });
        await until(async () => (await Effect.runPromise(on(owner, owner.maps.requests()))).calls > before.calls);
        return "accepted";
      }
      case "tick": {
        owner.clock.time.now += 1;
        return "accepted";
      }
      case "refusal": {
        if (event.retryAfter <= 0) return "refused";
        const latest = owner.searches.at(-1);
        const held = latest === undefined ? undefined : owner.cloud.searches[latest.index];
        if (event.token !== before.generation || before.pending !== event.token || latest === undefined || held === undefined) return "accepted";
        await held.open(Exit.fail(cloudFailure({ tag: "CloudRateLimited", retryAt: owner.clock.time.now + event.retryAfter })));
        await Effect.runPromise(Fiber.await(latest.fiber));
        return "accepted";
      }
      case "reopen": {
        await Effect.runPromise(on(owner, owner.maps.reopen()));
        return "accepted";
      }
      case "retireSession": {
        await connect(owner);
        owner.searches.length = 0;
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: async (key) => {
    const owner = await phone(key);
    return view(await Effect.runPromise(on(owner, owner.maps.requests())));
  },
};

export const options: Options<View> = { view, keys: ["phone"] };
