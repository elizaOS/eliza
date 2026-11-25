// spec/maps/observation.md, "Story: Let the agent see only what the Maps screen shows now"; spec/maps/observation.md, "Story: Locate me without an old locate getting in the way"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/maps__observation.conformance.ts";
import type { LocateAttempt, MapsObservation, SearchSource } from "../../gen/maps__observation.ts";
import { mapsObservation, type MapsObservationPort, type MapsSearchSource, type MapsSelectedObject } from "@elizaos/plugin-maps-client";

interface View {
  readonly revision: number;
  readonly live: boolean;
  readonly captured: boolean;
  readonly receiptRevision: number;
  readonly lastAccepted: boolean;
  readonly receiptMatches: boolean;
  readonly locate: LocateAttempt;
}

const same = (a: SearchSource, b: SearchSource) => a.query === b.query && a.area === b.area && a.results === b.results && a.provider === b.provider && a.ready === b.ready;
const view = ({ search, locate }: MapsObservation): View => ({
  revision: search.revision, live: search.live, captured: search.captured, receiptRevision: search.receiptRevision,
  lastAccepted: search.lastAccepted, receiptMatches: same(search.receiptSource, search.source), locate,
});
const text = (value: number) => value === 0 ? "" : `v${value}`;
const sourceOf = (source: SearchSource): MapsSearchSource => ({
  query: text(source.query), area: text(source.area), results: source.results === 0 ? [] : [text(source.results)], provider: text(source.provider), ready: source.ready,
});

const screens = new Map<string, { readonly port: MapsObservationPort; seen?: MapsSelectedObject }>();

function screen(key: string) {
  const known = screens.get(key);
  if (known !== undefined) return known;
  const made = { port: Effect.runSync(mapsObservation()) } as { readonly port: MapsObservationPort; seen?: MapsSelectedObject };
  screens.set(key, made);
  return made;
}

export const driver: Driver<View> = {
  reset() {
    screens.clear();
  },
  async dispatch(key, event) {
    const { port } = screen(key);
    const entry = screen(key);
    const before = await Effect.runPromise(port.state());
    const { search, locate } = before;
    const locateAllowed = (allowed: boolean, run: Effect.Effect<MapsObservation>) => allowed ? Effect.runPromise(run).then(() => "accepted" as const) : "refused" as const;
    switch (event.type) {
      case "publishSource": return locateAllowed(search.live, port.publish(sourceOf(event.nextSource)));
      case "captureObservation": {
        if (!search.live || search.captured) return "refused";
        entry.seen = await Effect.runPromise(port.observe());
        return "accepted";
      }
      case "validateObservation": {
        if (!search.captured || entry.seen === undefined) return "refused";
        await Effect.runPromise(port.validate(entry.seen));
        return "accepted";
      }
      case "closeScreen": return locateAllowed(search.live, port.close());
      case "cancelLocate": return locateAllowed(locate.owner && locate.phase === "OldLoading", port.cancelLocate());
      case "locateAgain": return locateAllowed(locate.owner && locate.generation === 1, port.locateAgain());
      case "typeOrigin": return locateAllowed(locate.owner && locate.generation === 1, port.typeOrigin());
      case "acceptFix": return locateAllowed(locate.owner && locate.phase === "NewLoading", port.acceptFix());
      case "cleanupDone": return locateAllowed(locate.cleanupPending, port.cleanupDone());
      case "cleanupFailed": return locateAllowed(locate.cleanupPending, port.cleanupFailed());
      case "leaveMaps": return locateAllowed(locate.owner, port.leaveMaps());
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: async (key) => view(await Effect.runPromise(screen(key).port.state())),
};

export const options: Options<View> = { view, keys: ["screen"] };
