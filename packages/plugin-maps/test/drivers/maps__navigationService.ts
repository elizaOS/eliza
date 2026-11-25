// spec/maps/navigationService.md, "Story: Keep guiding with the screen off when the exact native session can continue"
import { Effect, Exit, Fiber } from "effect";
import type { Driver, Options } from "../../gen/maps__navigationService.conformance.ts";
import type { Navigation } from "../../gen/maps__navigationService.ts";
import { backgroundNavigation, NavigationBridgeFailed, type BackgroundNavigation } from "@elizaos/plugin-maps-client";
import { gate, until, type Gate } from "../support/gates.ts";

type View = Omit<Navigation, "route"> & { readonly routed: boolean };
const view = ({ route, ...rest }: Navigation): View => ({ ...rest, routed: route > 0 });

interface Phone {
  readonly guidance: BackgroundNavigation;
  readonly availability: Gate<{ readonly background: boolean }, NavigationBridgeFailed>[];
  readonly starts: Gate<void, NavigationBridgeFailed>[];
  stopped?: (reason: string) => void;
  starting?: Fiber.Fiber<boolean>;
}

const phones = new Map<string, Phone>();

function phone(key: string): Phone {
  const known = phones.get(key);
  if (known !== undefined) return known;
  const made = { availability: [], starts: [] } as unknown as Phone;
  (made as { guidance: BackgroundNavigation }).guidance = Effect.runSync(backgroundNavigation({
    availability: () => {
      const held = gate<{ readonly background: boolean }, NavigationBridgeFailed>();
      made.availability.push(held);
      return held.wait;
    },
    listen: (_sessionId, stopped) => Effect.sync(() => {
      made.stopped = stopped;
      return () => { if (made.stopped === stopped) made.stopped = undefined; };
    }),
    start: () => {
      const held = gate<void, NavigationBridgeFailed>();
      made.starts.push(held);
      return held.wait;
    },
    update: () => Effect.succeed({ active: true }),
    stop: () => Effect.succeed({ stopped: true }),
  }, () => undefined));
  phones.set(key, made);
  return made;
}

export const driver: Driver<View> = {
  reset() {
    phones.clear();
  },
  async dispatch(key, event) {
    const owner = phone(key);
    const { guidance } = owner;
    const before = await Effect.runPromise(guidance.state());
    const state = async () => Effect.runPromise(guidance.state());
    const transition = async (allowed: boolean, work: Effect.Effect<unknown>) => {
      if (!allowed) return "refused" as const;
      await Effect.runPromise(work);
      return "accepted" as const;
    };
    const live = before.phase === "LiveGuidance";
    const current = (owned: number) => live && owned === before.generation;
    switch (event.type) {
      case "startGuidance": {
        if (!(before.visible && before.mapsSelected && event.selected && event.route > 0)) return "refused";
        const asked = owner.availability.length;
        owner.starting = Effect.runFork(guidance.start(`route-${event.route}`, "500 m · Turn right", "12 min"));
        await until(() => owner.availability.length > asked);
        return "accepted";
      }
      case "reserveBackground": {
        if (!(current(event.owner) && before.background === "Reserving")) return "refused";
        const asked = owner.starts.length;
        await owner.availability.at(-1)?.open(Exit.succeed({ background: true }));
        await until(() => owner.starts.length > asked);
        return "accepted";
      }
      case "finishBackground": {
        if (!(current(event.owner) && (before.background === "Reserving" || before.background === "AwaitingNative"))) return "refused";
        if (before.background === "Reserving") await owner.availability.at(-1)?.open(Exit.succeed({ background: false }));
        else await owner.starts.at(-1)?.open(event.nativeStarted ? Exit.succeed(undefined) : Exit.fail(new NavigationBridgeFailed({ operation: "start" })));
        if (owner.starting !== undefined) await Effect.runPromise(Fiber.await(owner.starting));
        return "accepted";
      }
      case "loseBackground": {
        if (!(current(event.owner) && (before.background === "AwaitingNative" || before.background === "ScreenOff")) || owner.stopped === undefined) return "refused";
        owner.stopped(event.reason === "NotificationStop" ? "notification" : "unavailable");
        await until(async () => (await state()).generation !== before.generation || (await state()).background !== before.background);
        return "accepted";
      }
      case "hideGuidance": return transition(before.visible, guidance.hide());
      case "showGuidance": return transition(!before.visible, guidance.show());
      case "leaveMaps": return transition(before.mapsSelected, guidance.leave());
      case "selectMaps": return transition(!before.mapsSelected, guidance.select());
      case "endGuidance": return transition(before.phase !== "NoGuidance", guidance.end());
      case "providerRetires": return transition(before.phase !== "NoGuidance", guidance.providerRetires());
      case "observePermissionHold":
        return transition(current(event.owner) && (event.locationPrompt !== before.locationPrompt || event.controllerPrompt !== before.controllerPrompt),
          guidance.permissionHold(event.locationPrompt, event.controllerPrompt));
      case "arrive": return transition(current(event.owner) && event.exactRoute && event.usableFix, guidance.arrive(event.exactRoute, event.usableFix));
      case "watchFailed": return transition(current(event.owner), guidance.watchFailed());
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: async (key) => view(await Effect.runPromise(phone(key).guidance.state())),
};

export const options: Options<View> = { view, keys: ["phone"] };
