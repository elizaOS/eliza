// spec/agent/conversation/events.md, "Story: Hear about my conversations while my screen is open"; spec/agent/conversation/events.md, "Story: Stop hearing when I leave"; spec/agent/conversation/events.md, "Story: Learn when something keeps going wrong"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/agent__conversation__events.conformance.ts";
import type { Event, EventFeed, FeedEvent, StreamName } from "../../gen/agent__conversation__events.ts";
import type { AgentEvent } from "../../src/access/events-port.vibe";
import { makeFeedHub, wireStreams, type EventHub, type WireStream } from "../../src/conversation/events.vibe";

interface Entity {
  readonly hub: EventHub;
  readonly inbox: { listener: (event: AgentEvent) => boolean };
  readonly expiries: Map<string, (() => void)[]>;
  readonly seqs: Map<string, number>;
}

const wireOf = Object.fromEntries(Object.entries(wireStreams).map(([wire, name]) => [name, wire])) as Record<StreamName, WireStream>;

const entities = new Map<string, Entity>();

function entity(key: string): Entity {
  const found = entities.get(key);
  if (found !== undefined) return found;
  const inbox = { listener: (_event: AgentEvent) => false };
  const expiries = new Map<string, (() => void)[]>();
  const seqs = new Map<string, number>();
  const hub = Effect.runSync(makeFeedHub({
    events: {
      emit: (stream) => {
        const seq = (seqs.get(stream) ?? 0) + 1;
        seqs.set(stream, seq);
        return { runId: stream, seq };
      },
      onNotification: (listener) => {
        inbox.listener = listener;
        return () => { inbox.listener = () => false; };
      },
    },
    storeNotice: () => undefined,
    expireLater: (code, expire) => {
      const queued = [...(expiries.get(code) ?? []), expire];
      expiries.set(code, queued);
      return () => expiries.set(code, (expiries.get(code) ?? []).filter((other) => other !== expire));
    },
  }));
  const made: Entity = { hub, inbox, expiries, seqs };
  entities.set(key, made);
  return made;
}

function publish({ hub, inbox }: Entity, plugin: boolean, news: FeedEvent): boolean {
  const send = (stream: WireStream, payload: unknown, clientId?: string) =>
    plugin ? hub.fromPlugin(stream, payload) : hub.publish(stream, payload, clientId);
  switch (news.tag) {
    case "ConversationUpdated": return send("conversation", { type: "conversation-updated" });
    case "ProactiveMessage": return send("conversation", { type: "proactive-message" });
    case "SystemNotice": return send("conversation", { type: "system-notice" });
    case "InboxChanged": return plugin ? hub.fromPlugin("notification", {}) : inbox.listener({ stream: "notification", runId: "inbox", seq: 1, payload: { id: "n1" } });
    case "ViewInteraction": return send("view-interact", { frame: "interact" }, news.clientId);
    case "Transcript": return send("voice-transcript", { kind: "partial" });
    default: {
      const unreachable: never = news;
      return unreachable;
    }
  }
}

function expire({ expiries }: Entity, code: string): boolean {
  const [oldest, ...rest] = expiries.get(code) ?? [];
  if (oldest === undefined) return false;
  expiries.set(code, rest);
  oldest();
  return true;
}

function dispatch(key: string, event: Event): "accepted" | "refused" {
  const found = entity(key);
  const { hub } = found;
  const accepted = (done: boolean) => done ? "accepted" as const : "refused" as const;
  switch (event.type) {
    case "subscribe": {
      const feed = hub.subscribe(
        { streams: event.streams.map((name) => wireOf[name]), clientId: event.clientId === "" ? undefined : event.clientId },
        { deliver: () => undefined, end: () => undefined },
      );
      return accepted(feed.kind === "live");
    }
    case "publish": return accepted(publish(found, event.source === "PluginSource", event.news));
    case "closeFeed": return accepted(hub.close(event.feed));
    case "backlog": return accepted(hub.backlog(event.feed, event.queuedBytes, event.frameBytes) !== "refused");
    case "stop": return accepted(hub.stop());
    case "expireStrike": return accepted(expire(found, event.code));
    case "reportError": return accepted(hub.reportError(event.code, event.cause, event.quiet));
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export const driver: Driver<EventFeed> = {
  reset() {
    entities.clear();
  },
  dispatch,
  observe: (key) => entity(key).hub.current(),
};

export const options: Options<EventFeed> = {
  keys: ["agent"],
};
