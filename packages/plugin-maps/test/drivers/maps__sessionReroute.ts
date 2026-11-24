// spec/maps/sessionReroute.md, "Story: Reroute the navigation I started, whoever planned the route"
import { Effect, Exit, Fiber } from "effect";
import type { Driver, Options } from "../../gen/maps__sessionReroute.conformance.ts";
import type { GuidedSession } from "../../gen/maps__sessionReroute.ts";
import { usableNavigationFix } from "@elizaos/plugin-maps-client";
import { until } from "../support/gates.ts";
import { coordinateOf, heldScreen, positionOf, routeTo, type HeldScreen } from "../support/screen.ts";

type View = Omit<GuidedSession, "route"> & { readonly routed: boolean };
const view = ({ route, ...rest }: GuidedSession): View => ({ ...rest, routed: route > 0 });

interface Entity {
  readonly screen: HeldScreen;
  running?: Fiber.Fiber<unknown, unknown>;
}

const entities = new Map<string, Entity>();

function entity(key: string): Entity {
  const known = entities.get(key);
  if (known !== undefined) return known;
  const made: Entity = { screen: heldScreen() };
  entities.set(key, made);
  return made;
}

export const driver: Driver<View> = {
  reset() {
    entities.clear();
  },
  async dispatch(key, event) {
    const owner = entity(key);
    const { phone, shown, reroutes } = owner.screen;
    const s = await Effect.runPromise(phone.session());
    switch (event.type) {
      case "ownerStarts": {
        if (s.phase !== "NoSession" || event.session <= s.session || event.route <= 0) return "refused";
        shown.guidance = { session: event.session, routeId: `route-${event.route}`, placeName: "Ferry Building", travelMode: "drive", rerouting: false, arrived: false };
        await Effect.runPromise(phone.guidanceStarted(shown.guidance));
        return "accepted";
      }
      case "startSessionReroute": {
        const position = positionOf(event.fix.age, event.fix.accuracy, event.fix.precise);
        if (s.phase !== "SessionGuiding" || !event.fix.present || !usableNavigationFix(position, Date.now()) || shown.guidance === null) return "refused";
        shown.guidance = { ...shown.guidance, fix: position };
        const asked = reroutes.length;
        owner.running = Effect.runFork(Effect.exit(phone.reroute()));
        await until(() => reroutes.length > asked);
        return "accepted";
      }
      case "sessionRerouteSettles": {
        const active = shown.guidance;
        if (s.phase !== "SessionRerouting" || event.ticket !== s.ticket || active === null) return "refused";
        if (event.sameSession && event.route > 0) shown.guidance = { ...active, routeId: `route-${event.route}` };
        const route = event.route > 0 ? routeTo(`route-${event.route}`, coordinateOf("Ferry Building"), "drive") : undefined;
        await reroutes.at(-1)?.open(Exit.succeed({ session: event.sameSession ? active.session : active.session + 100, ...(route === undefined ? {} : { route }) }));
        if (owner.running !== undefined) await Effect.runPromise(Fiber.await(owner.running));
        return "accepted";
      }
      case "sessionEnds": {
        if (s.phase === "NoSession") return "refused";
        shown.guidance = null;
        await Effect.runPromise(phone.guidanceEnded());
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: async (key) => view(await Effect.runPromise(entity(key).screen.phone.session())),
};

export const options: Options<View> = { view, keys: ["phone"] };
