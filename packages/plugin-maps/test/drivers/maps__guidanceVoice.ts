// spec/maps/guidanceVoice.md, "Story: Hear the newest turn instruction when my current route can speak"
import { Effect, Exit } from "effect";
import type { Driver, Options } from "../../gen/maps__guidanceVoice.conformance.ts";
import type { GuidanceVoice } from "../../gen/maps__guidanceVoice.ts";
import { GuidanceSpeechStopped, navigationVoice, type NavigationVoice } from "@elizaos/plugin-maps-client";
import { gate, until, type Gate } from "../support/gates.ts";

const view = (s: GuidanceVoice) => ({
  voiceOn: s.voiceOn, hidden: s.hidden, sheetOpen: s.sheetOpen, latestId: s.latest.instructionId, nextInstruction: s.nextInstruction,
  latestSpoken: s.latest.maneuverKey === s.spokenKey, spoken: s.spokenKey > 0, owns: s.latest.authorityId === s.authorityId,
  activeId: s.activeInstruction.instructionId, activeOwns: s.activeInstruction.authorityId === s.authorityId, activeAttempt: s.activeAttempt,
  owedInstruction: s.owedInstruction, speechSawHidden: s.speechSawHidden, starts: s.starts, failures: s.failures,
});
type View = ReturnType<typeof view>;

interface Screen {
  readonly voice: NavigationVoice;
  latest?: Gate<void, GuidanceSpeechStopped>;
  authority: number;
}

const screens = new Map<string, Screen>();
const ticks = () => until(() => Effect.runPromise(Effect.as(Effect.sleep(1), true)));

function screen(key: string): Screen {
  const known = screens.get(key);
  if (known !== undefined) return known;
  const made = { authority: 0 } as Screen;
  (made as { voice: NavigationVoice }).voice = Effect.runSync(navigationVoice({
    speak: () => {
      const held = gate<void, GuidanceSpeechStopped>();
      made.latest = held;
      return held.wait;
    },
  }, () => undefined));
  screens.set(key, made);
  return made;
}

const reasons = { VisibilityInterrupted: "interrupted", PlaybackFailed: "failed", CleanupUnconfirmed: "cleanup-unconfirmed" } as const;

export const driver: Driver<View> = {
  reset() {
    screens.clear();
  },
  async dispatch(key, event) {
    const { voice, ...current } = screen(key);
    const owner = screen(key);
    const before = await Effect.runPromise(voice.state());
    const run = async (work: Effect.Effect<unknown>) => {
      await Effect.runPromise(work);
      await ticks();
      return "accepted" as const;
    };
    switch (event.type) {
      case "pauseGuidanceVoice": return run(voice.pause());
      case "toggleGuidanceVoice": return run(voice.toggle(event.voiceAllowed));
      case "offerGuidance":
        return event.maneuverKey > 0 && event.textId > 0 ? run(voice.offer(`k${event.maneuverKey}`, `t${event.textId}`, event.voiceAllowed)) : "refused";
      case "hideGuidance": return before.hidden ? "refused" : run(voice.hide());
      case "showGuidance": return before.hidden ? run(voice.show(event.voiceAllowed)) : "refused";
      case "setGuidanceSheet": return run(voice.sheet(event.sheetOpen));
      case "changeGuidanceAuthority": {
        if (event.authorityId < 0 || event.authorityId === current.authority) return "refused";
        owner.authority = event.authorityId;
        return run(voice.authority(event.authorityId === 0 ? "" : `a${event.authorityId}`));
      }
      case "settleGuidance": {
        if (before.activeAttempt === 0) return "refused";
        const speaking = owner.latest;
        if (!event.exactAttempt || speaking === undefined) return "accepted";
        await Effect.runPromise(voice.allow(event.voiceAllowed));
        await speaking.open(event.voiceReply === "PlaybackDone" ? Exit.succeed(undefined) : Exit.fail(new GuidanceSpeechStopped({ reason: reasons[event.voiceReply] })));
        await until(async () => (await Effect.runPromise(voice.state())).activeAttempt !== before.activeAttempt);
        await ticks();
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: async (key) => view(await Effect.runPromise(screen(key).voice.state())),
};

export const options: Options<View> = { view, keys: ["screen"] };
