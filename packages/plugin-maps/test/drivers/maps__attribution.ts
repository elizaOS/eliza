// spec/maps/attribution.md, "Story: Show the right copyright for the map I am looking at"
import { Effect, Exit, Fiber } from "effect";
import type { Driver, Options } from "../../gen/maps__attribution.conformance.ts";
import type { MapAttribution } from "../../gen/maps__attribution.ts";
import { MapsFailure } from "@elizaos/plugin-maps-client";
import { viewportAttribution, type CloudMapsBasemap, type MapsViewport } from "@elizaos/plugin-maps-client";
import { gate, until, type Gate } from "../support/gates.ts";

interface Map {
  readonly attribution: Effect.Success<ReturnType<typeof viewportAttribution>>;
  readonly replies: Gate<string, MapsFailure>[];
  readonly asked: Fiber.Fiber<string>[];
  views: number;
}

const maps = new globalThis.Map<string, Map>();
const viewAt = (index: number): MapsViewport => ({ zoom: 12, north: index + 1, south: index, east: index + 1, west: index });

function mapOf(key: string): Map {
  const known = maps.get(key);
  if (known !== undefined) return known;
  const replies: Gate<string, MapsFailure>[] = [];
  const basemap: CloudMapsBasemap = {
    kind: "cloud-raster", attribution: "Google", minZoom: 0, maxZoom: 20, tileSize: 256,
    tile: () => Effect.succeed(new Uint8Array()),
    copyright: () => {
      const reply = gate<string, MapsFailure>();
      replies.push(reply);
      return reply.wait;
    },
  };
  const made: Map = { attribution: Effect.runSync(viewportAttribution(basemap)), replies, asked: [], views: 0 };
  maps.set(key, made);
  return made;
}

export const driver: Driver = {
  reset() {
    maps.clear();
  },
  async dispatch(key, event) {
    const map = mapOf(key);
    const before = await Effect.runPromise(map.attribution.state());
    switch (event.type) {
      case "moveView": {
        if (!before.alive) return "refused";
        map.views += 10;
        await Effect.runPromise(map.attribution.move(viewAt(map.views)));
        return "accepted";
      }
      case "requestAttribution": {
        if (!before.alive) return "refused";
        map.asked.push(Effect.runFork(map.attribution.show(viewAt(map.views))));
        await until(() => map.replies.length >= before.nextToken);
        return "accepted";
      }
      case "replyAttribution": {
        if (!(event.token > 0 && event.token < before.nextToken)) return "refused";
        const reply = map.replies[event.token - 1];
        const asked = map.asked[event.token - 1];
        if (reply === undefined || asked === undefined) return "accepted";
        await reply.open(event.success ? Exit.succeed(`Map data ${event.token}`) : Exit.fail(new MapsFailure({ code: "unavailable", message: "No copyright." })));
        await Effect.runPromise(Fiber.await(asked));
        return "accepted";
      }
      case "disposeMap": {
        if (!before.alive) return "refused";
        await Effect.runPromise(map.attribution.dispose());
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: (key): Promise<MapAttribution> => Effect.runPromise(mapOf(key).attribution.state()),
};

export const options: Options = { keys: ["map"] };
