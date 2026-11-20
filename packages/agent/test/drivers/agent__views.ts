// spec/agent/views.md, "Story: Declare my views once"; spec/agent/views.md, "Story: Switch to the view the agent named"; spec/agent/views.md, "Story: Answer what the agent asks a view"; spec/agent/views.md, "Story: Stop waiting when my agent stops"
import { Clock, Effect } from "effect";
import type { Driver, Options } from "../../gen/agent__views.conformance.ts";
import type { Event, Reply, ViewHost as ViewHostState } from "../../gen/agent__views.ts";
import { makeViewHost, type ViewAnswer, type ViewInteractFrame } from "../../src/views/host.vibe";

type Host = Effect.Success<ReturnType<typeof makeViewHost>>;

interface Entity {
  readonly host: Host;
  readonly subscribed: Map<string, number>;
  readonly frames: ViewInteractFrame[];
  readonly next: { id: string };
}

const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => 0,
  currentTimeMillis: Effect.sync(() => 0),
  currentTimeNanosUnsafe: () => 0n,
  currentTimeNanos: Effect.sync(() => 0n),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.sync(() => 0n),
  sleep: () => Effect.never,
};

const entities = new Map<string, Entity>();

const run = <A, E>(work: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(Effect.provideService(work, Clock.Clock, clock));

async function entity(key: string): Promise<Entity> {
  const found = entities.get(key);
  if (found !== undefined) return found;
  const subscribed = new Map<string, number>();
  const frames: ViewInteractFrame[] = [];
  const next = { id: "" };
  const host = await run(makeViewHost({
    publish: (_clientId, frame) => Effect.sync(() => { frames.push(frame); }),
    receivers: (clientId) => subscribed.get(clientId) ?? 0,
    onRendererClosed: () => undefined,
  }, () => next.id));
  const made: Entity = { host, subscribed, frames, next };
  entities.set(key, made);
  return made;
}

function answerOf(reply: Reply): ViewAnswer {
  switch (reply) {
    case "Switched": return { success: true, result: { switched: true } };
    case "NotSwitched": return { success: true, result: { switched: false } };
    case "Answered": return { success: true, result: { answered: true } };
  }
}

async function send(key: string, event: Event): Promise<"accepted" | "refused"> {
  const { host, subscribed, frames, next } = await entity(key);
  frames.length = 0;
  const accepted = (done: boolean) => done ? "accepted" as const : "refused" as const;
  switch (event.type) {
    case "bootViews": return accepted(await run(host.boot(event.views)));
    case "prepareNavigation": return accepted((await run(host.prepare(event.requestId, event.clientId, event.viewId))) !== undefined);
    case "showView": return accepted((await run(host.show(event.requestId, event.clientId, event.target))) !== undefined);
    case "claimRequest":
      next.id = event.claimId;
      return accepted((await run(host.claim(event.binding))) !== undefined);
    case "answerRequest": return accepted(await run(host.answer(event.binding, event.claimId, event.reply, answerOf(event.reply))));
    case "askView": {
      next.id = event.requestId;
      subscribed.set(event.clientId, event.subscribed ? 1 : 0);
      const asked = await run(host.ask({ clientId: event.clientId, viewId: event.viewId, capability: event.capability, params: {}, grant: event.grant }));
      return accepted(asked.kind === "asked");
    }
    case "abandonRequest": return accepted(await run(host.abandon(event.requestId)));
    case "closeHost": {
      const before = await run(host.current());
      await run(host.close());
      return accepted(before.phase !== "Closed");
    }
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export const driver: Driver<ViewHostState> = {
  async reset() {
    for (const { host } of entities.values()) await run(host.close());
    entities.clear();
  },
  dispatch: (key, event) => send(key, event),
  observe: async (key) => run((await entity(key)).host.current()),
  observeOutput: async (key) => [...(await entity(key)).frames],
};

export const options: Options<ViewHostState> = {
  keys: ["agent"],
};
