/**
 * Unit coverage for the `@elizaos/ui/events` barrel (src/events/index.ts):
 * the UI-only event-name constants, their typed dispatch helpers, the cloud-
 * handoff phase cache, focus-connector session persistence, and the
 * connect-request / native navigate-view replay queues owned here. Real-module
 * suite over jsdom — the subject is driven through its public path only.
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeNotificationCenterOpenRequest,
  peekNotificationCenterOpenRequest,
  subscribeNotificationCenterOpenRequests,
} from "../state/notifications/notification-center-open-request";
import {
  __resetLastCloudHandoffPhaseDetailForTests,
  APP_EMOTE_EVENT,
  CHAT_CLOSE_EVENT,
  CHAT_MESSAGE_SEARCH_EVENT,
  CHAT_OPEN_EVENT,
  CHAT_PREFILL_EVENT,
  CLOUD_HANDOFF_PHASE_EVENT,
  CLOUD_HANDOFF_RETRY_EVENT,
  CONNECT_EVENT,
  clearPendingFocusConnector,
  createNavigateViewEvent,
  dispatchAppEvent,
  dispatchBackIntent,
  dispatchChatClose,
  dispatchChatOpen,
  dispatchChatPrefill,
  dispatchCloudHandoffPhase,
  dispatchCloudHandoffRetry,
  dispatchConnectRequest,
  dispatchFocusConnector,
  dispatchNavigateViewRequest,
  dispatchOpenNotificationCenter,
  dispatchVoiceControl,
  dispatchWindowEvent,
  ELIZA_BACK_INTENT_EVENT,
  FOCUS_CONNECTOR_EVENT,
  getLastCloudHandoffPhaseDetail,
  listenForConnectRequests,
  listenForNavigateViewRequests,
  OPEN_NOTIFICATION_CENTER_EVENT,
  readPendingFocusConnector,
  VOICE_CONTROL_EVENT,
} from "./index";

const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** Records every event of `type` observed on `target` until `stop()`. */
function record(
  target: EventTarget,
  type: string,
): { events: CustomEvent[]; stop: () => void } {
  const events: CustomEvent[] = [];
  const handler = (event: Event): void => {
    events.push(event as CustomEvent);
  };
  target.addEventListener(type, handler);
  return {
    events,
    stop: () => target.removeEventListener(type, handler),
  };
}

/** Applies every pending native navigate-view intent so tests stay isolated. */
function drainNavigateViewQueue(): void {
  listenForNavigateViewRequests(() => true)();
}

/** Consumes any pending connect request left behind by a test. */
async function drainPendingConnectRequest(): Promise<void> {
  const off = listenForConnectRequests(() => {});
  await tick();
  off();
}

afterEach(async () => {
  __resetLastCloudHandoffPhaseDetailForTests();
  drainNavigateViewQueue();
  await drainPendingConnectRequest();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("UI-only event-name constants", () => {
  it("pins the literal wire values consumers and natives share", () => {
    expect(FOCUS_CONNECTOR_EVENT).toBe("eliza:focus-connector");
    expect(VOICE_CONTROL_EVENT).toBe("eliza:voice-control");
    expect(CLOUD_HANDOFF_PHASE_EVENT).toBe("eliza:cloud-handoff-phase");
    expect(CLOUD_HANDOFF_RETRY_EVENT).toBe("eliza:cloud-handoff-retry");
    expect(CHAT_PREFILL_EVENT).toBe("eliza:chat:prefill");
    expect(CHAT_OPEN_EVENT).toBe("eliza:chat:open");
    expect(CHAT_CLOSE_EVENT).toBe("eliza:chat:close");
    expect(CHAT_MESSAGE_SEARCH_EVENT).toBe("eliza:chat:message-search");
    expect(OPEN_NOTIFICATION_CENTER_EVENT).toBe("eliza:notifications:open");
    expect(ELIZA_BACK_INTENT_EVENT).toBe("eliza:back-intent");
  });

  it("re-exports the shared event vocabulary through the barrel", () => {
    expect(typeof APP_EMOTE_EVENT).toBe("string");
    expect(typeof CONNECT_EVENT).toBe("string");
    expect(typeof createNavigateViewEvent).toBe("function");
  });
});

describe("dispatchVoiceControl", () => {
  it("delivers start and stop commands as window custom events", () => {
    const sent = record(window, VOICE_CONTROL_EVENT);

    dispatchVoiceControl({ command: "start" });
    dispatchVoiceControl({ command: "stop" });

    expect(sent.events).toHaveLength(2);
    expect(sent.events[0].detail).toEqual({ command: "start" });
    expect(sent.events[1].detail).toEqual({ command: "stop" });
    sent.stop();
  });
});

describe("floating-chat dispatchers", () => {
  it("prefills the composer with optional draft selection", () => {
    const sent = record(window, CHAT_PREFILL_EVENT);

    dispatchChatPrefill({ text: "hello" });
    dispatchChatPrefill({ text: "pick me", select: true });

    expect(sent.events).toHaveLength(2);
    expect(sent.events[0].detail).toEqual({ text: "hello" });
    expect(sent.events[1].detail).toEqual({ text: "pick me", select: true });
    sent.stop();
  });

  it("opens and collapses the floating chat with distinct events", () => {
    const opened = record(window, CHAT_OPEN_EVENT);
    const closed = record(window, CHAT_CLOSE_EVENT);

    dispatchChatOpen();
    dispatchChatClose();

    expect(opened.events).toHaveLength(1);
    expect(closed.events).toHaveLength(1);
    opened.stop();
    closed.stop();
  });
});

describe("dispatchOpenNotificationCenter", () => {
  it("fires the window event and records a real open request", async () => {
    const sent = record(window, OPEN_NOTIFICATION_CENTER_EVENT);
    const received: number[] = [];
    const unsubscribe = subscribeNotificationCenterOpenRequests((id) => {
      received.push(id);
    });

    dispatchOpenNotificationCenter();

    expect(sent.events).toHaveLength(1);
    expect(received.length).toBeGreaterThan(0);
    expect(peekNotificationCenterOpenRequest()).toBe(received.at(-1));
    // The retained request stays pending until the visible center acks it.
    expect(
      acknowledgeNotificationCenterOpenRequest(received.at(-1) as number),
    ).toBe(true);
    expect(peekNotificationCenterOpenRequest()).toBeNull();

    unsubscribe();
    sent.stop();
  });
});

describe("cloud handoff phase surface", () => {
  it("starts with no cached phase this session", () => {
    expect(getLastCloudHandoffPhaseDetail()).toBeNull();
  });

  it("caches the latest dispatched phase for late-mounting surfaces", () => {
    const sent = record(window, CLOUD_HANDOFF_PHASE_EVENT);
    const migrating = {
      agentId: "agent-1",
      phase: "migrating",
    } as const;
    const switched = {
      agentId: "agent-1",
      phase: "switched",
      imported: 7,
    } as const;

    dispatchCloudHandoffPhase(migrating);
    expect(sent.events[0].detail).toBe(migrating);
    expect(getLastCloudHandoffPhaseDetail()).toBe(migrating);

    dispatchCloudHandoffPhase(switched);
    expect(sent.events[1].detail).toBe(switched);
    expect(getLastCloudHandoffPhaseDetail()).toBe(switched);

    sent.stop();
  });

  it("resets the cached phase between sessions", () => {
    dispatchCloudHandoffPhase({ agentId: "agent-1", phase: "failed" });
    expect(getLastCloudHandoffPhaseDetail()).not.toBeNull();

    __resetLastCloudHandoffPhaseDetailForTests();
    expect(getLastCloudHandoffPhaseDetail()).toBeNull();
  });

  it("dispatches handoff retry requests on window", () => {
    const sent = record(window, CLOUD_HANDOFF_RETRY_EVENT);

    dispatchCloudHandoffRetry({ agentId: "agent-9" });

    expect(sent.events).toHaveLength(1);
    expect(sent.events[0].detail).toEqual({ agentId: "agent-9" });
    sent.stop();
  });
});

describe("dispatchBackIntent", () => {
  it("reports false when no consumer handles the press", () => {
    expect(dispatchBackIntent()).toBe(false);
  });

  it("reports false when attached consumers ignore the press", () => {
    const seenDetails: Array<{ handled: boolean }> = [];
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, (event) => {
      seenDetails.push((event as CustomEvent<{ handled: boolean }>).detail);
    });

    expect(dispatchBackIntent()).toBe(false);
    expect(seenDetails).toEqual([{ handled: false }]);
  });

  it("reports true once a consumer flips handled synchronously", () => {
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, (event) => {
      const detail = (event as CustomEvent<{ handled: boolean }>).detail;
      if (!detail.handled) detail.handled = true;
    });

    expect(dispatchBackIntent()).toBe(true);
  });
});

describe("focus connector helpers", () => {
  const STORAGE_KEY = "elizaos:focus-connector";

  it("persists the trimmed connector id and dispatches it on document", () => {
    const sent = record(document, FOCUS_CONNECTOR_EVENT);

    dispatchFocusConnector("  gmail  ");

    expect(sent.events).toHaveLength(1);
    expect(sent.events[0].detail).toEqual({ connectorId: "gmail" });
    expect(readPendingFocusConnector()).toBe("gmail");
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe("gmail");
    sent.stop();
  });

  it("treats a blank connector id as a no-op", () => {
    const sent = record(document, FOCUS_CONNECTOR_EVENT);

    dispatchFocusConnector("   ");

    expect(sent.events).toHaveLength(0);
    expect(readPendingFocusConnector()).toBeNull();
    sent.stop();
  });

  it("reads null when nothing is pending", () => {
    expect(readPendingFocusConnector()).toBeNull();
  });

  it("clears only a matching connector id", () => {
    dispatchFocusConnector("gmail");

    clearPendingFocusConnector("not-gmail");
    expect(readPendingFocusConnector()).toBe("gmail");

    clearPendingFocusConnector("gmail");
    expect(readPendingFocusConnector()).toBeNull();
  });

  it("clears any stored id when called without one", () => {
    dispatchFocusConnector("slack");
    clearPendingFocusConnector();
    expect(readPendingFocusConnector()).toBeNull();
  });

  it("degrades gracefully when sessionStorage throws", () => {
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(readPendingFocusConnector()).toBeNull();

    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const sent = record(document, FOCUS_CONNECTOR_EVENT);
    dispatchFocusConnector("gmail");
    expect(sent.events).toHaveLength(1);
    expect(sent.events[0].detail).toEqual({ connectorId: "gmail" });
    sent.stop();
  });
});

describe("generic typed dispatch helpers", () => {
  it("dispatchAppEvent targets document with the given detail", () => {
    const sent = record(document, "eliza:test-doc-target");

    dispatchAppEvent("eliza:test-doc-target" as never, { n: 1 });

    expect(sent.events).toHaveLength(1);
    expect(sent.events[0].detail).toEqual({ n: 1 });
    sent.stop();
  });

  it("dispatchWindowEvent targets window with the given detail", () => {
    const sent = record(window, "eliza:test-window-target");

    dispatchWindowEvent("eliza:test-window-target" as never, { n: 2 });

    expect(sent.events).toHaveLength(1);
    expect(sent.events[0].detail).toEqual({ n: 2 });
    sent.stop();
  });
});

describe("connect-request replay queue", () => {
  it("replays only the newest pre-mount request, with full detail", async () => {
    dispatchConnectRequest({
      gatewayUrl: "wss://old.example.com",
      token: "stale",
    });
    const newest = {
      gatewayUrl: "wss://new.example.com",
      token: "fresh",
      completeFirstRun: true,
    };
    dispatchConnectRequest(newest);

    const received: Array<Record<string, unknown>> = [];
    const off = listenForConnectRequests((request) => {
      received.push({ ...request });
    });
    await tick();
    off();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(newest);
  });

  it("delivers live requests synchronously to mounted listeners", () => {
    const received: string[] = [];
    const off = listenForConnectRequests((request) => {
      received.push(request.gatewayUrl);
    });

    dispatchConnectRequest({ gatewayUrl: "wss://live.example.com" });

    expect(received).toEqual(["wss://live.example.com"]);
    off();
  });

  it("lets exactly one subscriber adopt a dispatched request", () => {
    const firstGot: string[] = [];
    const secondGot: string[] = [];
    const offFirst = listenForConnectRequests((r) => {
      firstGot.push(r.gatewayUrl);
    });
    const offSecond = listenForConnectRequests((r) => {
      secondGot.push(r.gatewayUrl);
    });

    dispatchConnectRequest({ gatewayUrl: "wss://once.example.com" });

    expect(firstGot).toEqual(["wss://once.example.com"]);
    expect(secondGot).toEqual([]);

    offFirst();
    offSecond();
  });

  it("passes legacy raw CONNECT_EVENT customs to every subscriber", () => {
    const firstGot: string[] = [];
    const secondGot: string[] = [];
    const offFirst = listenForConnectRequests((r) => {
      firstGot.push(r.gatewayUrl);
    });
    const offSecond = listenForConnectRequests((r) => {
      secondGot.push(r.gatewayUrl);
    });

    document.dispatchEvent(
      new CustomEvent(CONNECT_EVENT, {
        detail: { gatewayUrl: "wss://legacy.example.com" },
      }),
    );

    expect(firstGot).toEqual(["wss://legacy.example.com"]);
    expect(secondGot).toEqual(["wss://legacy.example.com"]);

    offFirst();
    offSecond();
  });

  it("ignores raw events whose detail is not a connect request", () => {
    const received: unknown[] = [];
    const off = listenForConnectRequests((request) => {
      received.push(request);
    });

    const invalid: unknown[] = [
      "not-an-object",
      42,
      ["array"],
      {},
      { gatewayUrl: 7 },
    ];
    for (const detail of invalid) {
      document.dispatchEvent(new CustomEvent(CONNECT_EVENT, { detail }));
    }

    expect(received).toEqual([]);
    off();
  });

  it("stops delivering after unsubscribe", async () => {
    const received: string[] = [];
    const off = listenForConnectRequests((request) => {
      received.push(request.gatewayUrl);
    });
    off();

    dispatchConnectRequest({ gatewayUrl: "wss://gone.example.com" });
    await tick();

    expect(received).toEqual([]);
  });
});

describe("navigate-view request queue", () => {
  it("resolves true once a listener applies and never redelivers", async () => {
    const applied = dispatchNavigateViewRequest({
      viewId: "wallet",
      viewPath: "/wallet",
    });

    const latecomer: string[] = [];
    const off = listenForNavigateViewRequests((event) => {
      latecomer.push((event as CustomEvent).detail.viewId);
      return true;
    });

    expect(latecomer).toEqual(["wallet"]);
    expect(await applied).toBe(true);

    // The committed request is durably consumed: a later mount sees nothing.
    const secondMount: string[] = [];
    const offSecond = listenForNavigateViewRequests((event) => {
      secondMount.push((event as CustomEvent).detail.viewId);
      return true;
    });
    expect(secondMount).toEqual([]);

    off();
    offSecond();
  });

  it("preserves FIFO order across several pending intents", async () => {
    const pending = [
      dispatchNavigateViewRequest({ viewId: "a", viewPath: "/a" }),
      dispatchNavigateViewRequest({ viewId: "b", viewPath: "/b" }),
      dispatchNavigateViewRequest({ viewId: "c", viewPath: "/c" }),
    ];

    const order: string[] = [];
    const off = listenForNavigateViewRequests((event) => {
      order.push((event as CustomEvent).detail.viewId);
      return true;
    });

    expect(order).toEqual(["a", "b", "c"]);
    expect(await Promise.all(pending)).toEqual([true, true, true]);
    off();
  });

  it("retries an intent declined with an explicit false", async () => {
    const appliedPromise = dispatchNavigateViewRequest({
      viewId: "chat",
      viewPath: "/chat",
    });

    let declinerCalls = 0;
    const offDecliner = listenForNavigateViewRequests(() => {
      declinerCalls += 1;
      return false;
    });

    let applierCalls = 0;
    const offApplier = listenForNavigateViewRequests(() => {
      applierCalls += 1;
      return true;
    });

    // The decliner saw the initial delivery AND the replay triggered by the
    // applier's mount; the applier's acceptance consumed the intent.
    expect(declinerCalls).toBe(2);
    expect(applierCalls).toBe(1);
    expect(await appliedPromise).toBe(true);

    offDecliner();
    offApplier();
  });

  it("does not let a throwing listener steal the intent", async () => {
    const appliedPromise = dispatchNavigateViewRequest({
      viewId: "settings",
      viewPath: "/settings",
    });

    const offThrower = listenForNavigateViewRequests(() => {
      throw new Error("listener exploded mid-apply");
    });
    const appliedBy: string[] = [];
    const offApplier = listenForNavigateViewRequests((event) => {
      appliedBy.push((event as CustomEvent).detail.viewId);
      return true;
    });

    expect(appliedBy).toEqual(["settings"]);
    expect(await appliedPromise).toBe(true);

    offThrower();
    offApplier();
  });

  it("drops the oldest past the 16-item bound and resolves it false", async () => {
    const promises: Array<Promise<boolean>> = [];
    for (let i = 1; i <= 17; i += 1) {
      promises.push(
        dispatchNavigateViewRequest({ viewId: `v${i}`, viewPath: `/${i}` }),
      );
    }

    // The overflowed oldest intent is surfaced as unapplied, never acked.
    expect(await promises[0]).toBe(false);

    // The surviving 16 stay queued in arrival order and apply normally.
    const order: string[] = [];
    const off = listenForNavigateViewRequests((event) => {
      order.push((event as CustomEvent).detail.viewId);
      return true;
    });

    expect(order).toHaveLength(16);
    expect(order[0]).toBe("v2");
    expect(order.at(-1)).toBe("v17");
    const survivors = await Promise.all(promises.slice(1));
    expect(survivors.every((applied) => applied === true)).toBe(true);
    off();
  }, 10_000);

  it("passes legacy raw navigation events without queuing them", () => {
    const firstMount: string[] = [];
    const offFirst = listenForNavigateViewRequests((event) => {
      firstMount.push((event as CustomEvent).detail.viewId);
      return true;
    });

    window.dispatchEvent(
      createNavigateViewEvent({ viewId: "legacy", viewPath: "/legacy" }),
    );
    expect(firstMount).toEqual(["legacy"]);

    // A legacy event never enters the replay queue: a later mount misses it.
    const secondMount: string[] = [];
    const offSecond = listenForNavigateViewRequests((event) => {
      secondMount.push((event as CustomEvent).detail.viewId);
      return true;
    });
    expect(secondMount).toEqual([]);

    offFirst();
    offSecond();
  });
});
