// spec/maps/cloudConnection.md, "Story: Keep Cloud Maps on the account that requested it"
import { type Clock, Effect } from "effect";
import { CloudError } from "@elizaos/cloud/client";
import type { MapsCloud } from "../../src/client/cloud-provider.vibe";
import { gate, type Gate } from "./gates.ts";

export const offer = {
  available: true as const, providerId: "google", connectionId: "conn_0123456789abcdef", revision: "2026-11", attribution: "Google Maps Platform via Eliza Cloud",
  sources: { data: "Google", search: "Google", routing: "Google" },
  disclosure: { recipients: [{ role: "gateway" as const, name: "Eliza Cloud", operator: "Eliza Labs" }], cloudRecords: "operation-and-result-code" as const },
  regions: [{ id: "world", name: "World", bounds: [-180, -90, 180, 90] as const }],
  capabilities: { map: false, search: true as const, placeDetails: true as const, geocode: true as const, reverseGeocode: true as const, placeLookup: true, modes: ["drive", "walk"] as const, alternatives: true, traffic: "live" as const, transit: "none" as const, offline: { map: false as const, search: false as const, routing: false as const } },
};

export const cloudFailure = (failure: CloudError["failure"]) => new CloudError({ failure, cause: "" });

export function heldCloud(answerCapabilities: boolean) {
  const capabilities: Gate<typeof offer, CloudError>[] = [];
  const searches: Gate<readonly unknown[], CloudError>[] = [];
  const run = <A>(held: Gate<A, CloudError>) => Effect.runPromise(Effect.result(held.wait)).then((result) => {
    if (result._tag === "Failure") throw result.failure;
    return result.success;
  });
  const client = {
    mapsCapabilities: () => {
      if (answerCapabilities) return Promise.resolve(offer);
      const held = gate<typeof offer, CloudError>();
      capabilities.push(held);
      return run(held);
    },
    mapsPlacesSearch: () => {
      const held = gate<readonly unknown[], CloudError>();
      searches.push(held);
      return run(held).then((places) => ({ providerId: "google", attribution: "Google", places }));
    },
  } as unknown as MapsCloud;
  return { client, capabilities, searches };
}

export function manualClock() {
  const time = { now: 0 };
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => time.now,
    currentTimeMillis: Effect.sync(() => time.now),
    currentTimeNanosUnsafe: () => BigInt(time.now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(time.now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(time.now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(time.now) * 1_000_000n),
    sleep: () => Effect.never,
  };
  return { time, clock };
}
