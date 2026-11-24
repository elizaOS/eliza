// spec/maps/cloudConnection.md, "Story: Keep Cloud Maps on the account that requested it"
import { Effect, Exit, Fiber } from "effect";
import type { Driver, Options } from "../../gen/maps__cloudConnection.conformance.ts";
import type { MapsBinding, MapsConnection } from "../../gen/maps__cloudConnection.ts";
import { cloudMaps, type CloudMaps, type MapsCloud } from "@elizaos/plugin-maps-client";
import { cloudFailure, heldCloud, offer } from "../support/cloud.ts";
import { until } from "../support/gates.ts";

interface View {
  readonly phase: MapsConnection["phase"];
  readonly generation: number;
  readonly bound: boolean;
  readonly publishedForBinding: boolean;
}

const bound = (binding: MapsBinding) => binding.session > 0 && binding.credential > 0 && binding.client > 0;
const sameAccount = (a: MapsBinding, b: MapsBinding) => bound(a) && bound(b) && a.session === b.session && a.credential === b.credential;
const view = (s: MapsConnection): View => ({ phase: s.phase, generation: s.generation, bound: bound(s.binding), publishedForBinding: s.phase === "PublishedCoverage" && sameAccount(s.binding, s.publisher) });
const signedOut: MapsBinding = { session: 0, credential: 0, client: 0 };

interface Phone {
  readonly maps: CloudMaps;
  readonly clients: Map<number, ReturnType<typeof heldCloud>>;
  readonly reads: Map<number, { readonly answer: (reply: "ValidCoverage" | "InvalidCoverage" | "CoverageUnavailable" | "CoverageCancelled") => Promise<void>; readonly fiber: Fiber.Fiber<void> }>;
  binding: MapsBinding;
}

const phones = new Map<string, Phone>();

function phone(key: string): Phone {
  const known = phones.get(key);
  if (known !== undefined) return known;
  const made: Phone = { maps: Effect.runSync(cloudMaps(() => undefined)), clients: new Map(), reads: new Map(), binding: signedOut };
  phones.set(key, made);
  return made;
}

function clientFor(owner: Phone, number: number): ReturnType<typeof heldCloud> {
  const known = owner.clients.get(number);
  if (known !== undefined) return known;
  const made = heldCloud(false);
  owner.clients.set(number, made);
  return made;
}

export const driver: Driver<View> = {
  reset() {
    phones.clear();
  },
  async dispatch(key, event) {
    const owner = phone(key);
    const before = await Effect.runPromise(owner.maps.connection());
    switch (event.type) {
      case "bindMaps": {
        const next = event.binding;
        const unchanged = next.session === owner.binding.session && next.credential === owner.binding.credential && next.client === owner.binding.client;
        const signedOutBinding = next.session === 0 && next.credential === 0 && next.client === 0;
        if (unchanged || !(bound(next) || signedOutBinding)) return "refused";
        owner.binding = next;
        const client: MapsCloud | undefined = signedOutBinding ? undefined : clientFor(owner, next.client).client;
        await Effect.runPromise(owner.maps.bind(client === undefined ? undefined : { session: `s${next.session}`, credential: `k${next.credential}`, client }));
        return "accepted";
      }
      case "readCoverage": {
        if (!(event.force || before.phase === "NeverRead" || before.phase === "FailedCoverage" || before.phase === "RetiredCoverage")) return "refused";
        const held = bound(owner.binding) ? clientFor(owner, owner.binding.client) : undefined;
        const asked = held?.capabilities.length ?? 0;
        const fiber = Effect.runFork(owner.maps.initialize(event.force));
        if (held === undefined) {
          await Effect.runPromise(Fiber.await(fiber));
          return "accepted";
        }
        await until(() => held.capabilities.length > asked);
        const generation = (await Effect.runPromise(owner.maps.connection())).generation;
        const capability = held.capabilities[asked];
        if (capability === undefined) throw new Error("The coverage read never reached Cloud");
        owner.reads.set(generation, {
          fiber,
          answer: (reply) => capability.open(reply === "ValidCoverage" ? Exit.succeed(offer) : Exit.fail(cloudFailure({ tag: "CloudProviderIssue" }))),
        });
        return "accepted";
      }
      case "coverageSettles": {
        const read = owner.reads.get(event.attempt);
        if (event.attempt !== before.generation || before.phase !== "PendingCoverage" || read === undefined) return "refused";
        await read.answer(event.reply);
        await Effect.runPromise(Fiber.await(read.fiber));
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: async (key) => view(await Effect.runPromise(phone(key).maps.connection())),
};

export const options: Options<View> = { view, keys: ["phone"] };
