// spec/maps/navigation.md, "Story: Plan directions and keep me in control of guidance"
import { Effect, Exit, Fiber } from "effect";
import type { Driver, Options } from "../../gen/maps__navigation.conformance.ts";
import type { Directions, Travel } from "../../gen/maps__navigation.ts";
import type { TravelMode } from "@elizaos/plugin-maps-client";
import { usableNavigationFix } from "@elizaos/plugin-maps-client";
import { until } from "../support/gates.ts";
import { coordinateOf, heldScreen, positionOf, routeTo, type HeldScreen } from "../support/screen.ts";

type View = Omit<Directions, "owner" | "route"> & { readonly owned: boolean; readonly routed: boolean };
const view = ({ owner, route, ...rest }: Directions): View => ({ ...rest, owned: owner > 0, routed: route > 0 });
const modes: Record<Travel, TravelMode> = { Drive: "drive", Walk: "walk", Bicycle: "bicycle", Transit: "transit" };

interface Entity {
  readonly screen: HeldScreen;
  running?: Fiber.Fiber<unknown, unknown>;
  sessions: number;
}

const entities = new Map<string, Entity>();

function entity(key: string): Entity {
  const known = entities.get(key);
  if (known !== undefined) return known;
  const made: Entity = { screen: heldScreen(), sessions: 0 };
  entities.set(key, made);
  return made;
}

async function finished(owner: Entity): Promise<void> {
  if (owner.running !== undefined) await Effect.runPromise(Fiber.await(owner.running));
}

export const driver: Driver<View> = {
  reset() {
    entities.clear();
  },
  async dispatch(key, event) {
    const owner = entity(key);
    const { phone, shown, grants, fixes, plans, reroutes } = owner.screen;
    const s = await Effect.runPromise(phone.directions());
    const current = (ticket: number) => ticket === s.ticket && s.selection === s.capturedSelection;
    switch (event.type) {
      case "startPlan": {
        const plan = event.plan;
        if (s.active || plan.ownerId <= 0 || plan.destination === "" || !plan.providerReady || !plan.modeSupported || !plan.validReference) return "refused";
        const asked = grants.length;
        const destination = { provider: "eliza-cloud", providerPlaceId: plan.destination, name: plan.destination, coordinates: coordinateOf(plan.destination) };
        owner.running = Effect.runFork(Effect.exit(phone.start({ destination, travelMode: modes[plan.travel] })));
        await until(() => grants.length > asked);
        return "accepted";
      }
      case "selectionChanges": {
        if (s.owner <= 0 || s.active) return "refused";
        await Effect.runPromise(phone.sheetChanged());
        return "accepted";
      }
      case "receiveFix": {
        const position = positionOf(event.fix.age, event.fix.accuracy, event.fix.precise);
        if (s.phase !== "AwaitingFix" || !current(event.ticket) || !event.alreadyGranted || !event.fix.present || !usableNavigationFix(position, Date.now())) return "refused";
        const asked = plans.length;
        const located = fixes.length;
        await grants.at(-1)?.open(Exit.succeed(true));
        await until(() => fixes.length > located);
        await fixes.at(-1)?.open(Exit.succeed(position));
        await until(() => plans.length > asked);
        return "accepted";
      }
      case "planSettles": {
        if (s.phase !== "Planning" || !current(event.ticket)) return "refused";
        const exact = event.result.route > 0 && event.result.destination === s.destination && event.result.travel === s.travel;
        const travel = modes[event.result.travel];
        await plans.at(-1)?.open(Exit.succeed(exact ? routeTo("planned", coordinateOf(s.destination), travel) : routeTo("elsewhere", { latitude: 0, longitude: 0 }, travel)));
        await finished(owner);
        return "accepted";
      }
      case "confirmGuidance": {
        if (s.phase !== "Confirm" || s.route <= 0) return "refused";
        await Effect.runPromise(phone.confirmed());
        owner.sessions += 1;
        shown.guidance = { session: owner.sessions, routeId: "planned", placeName: s.destination, travelMode: modes[s.travel], rerouting: false, arrived: false };
        await Effect.runPromise(phone.guidanceStarted(shown.guidance));
        return "accepted";
      }
      case "startReroute": {
        const position = positionOf(event.fix.age, event.fix.accuracy, event.fix.precise);
        if (s.phase !== "Guiding" || !event.fix.present || !usableNavigationFix(position, Date.now()) || shown.guidance === null) return "refused";
        shown.guidance = { ...shown.guidance, fix: position };
        const asked = reroutes.length;
        owner.running = Effect.runFork(Effect.exit(phone.reroute()));
        await until(() => reroutes.length > asked);
        return "accepted";
      }
      case "rerouteSettles": {
        const active = shown.guidance;
        if (s.phase !== "Rerouting" || event.ticket !== s.ticket || active === null) return "refused";
        if (event.sameSession && event.route > 0) shown.guidance = { ...active, routeId: `route-${event.route}` };
        const route = event.route > 0 ? routeTo(`route-${event.route}`, coordinateOf(s.destination), modes[s.travel]) : undefined;
        await reroutes.at(-1)?.open(Exit.succeed({ session: event.sameSession ? active.session : active.session + 100, ...(route === undefined ? {} : { route }) }));
        await finished(owner);
        return "accepted";
      }
      case "stop": {
        if (s.phase === "Idle") return "refused";
        await Effect.runPromise(Effect.exit(phone.stop()));
        await Effect.runPromise(phone.guidanceEnded());
        return "accepted";
      }
      case "retire": {
        if (s.owner <= 0) return "refused";
        await Effect.runPromise(phone.retire());
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
  observe: async (key) => view(await Effect.runPromise(entity(key).screen.phone.directions())),
};

export const options: Options<View> = { view, keys: ["phone"] };
