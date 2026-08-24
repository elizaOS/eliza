/**
 * Composition-root contract for client.ts: the singleton `client` must carry
 * every domain method installed on ElizaClient.prototype by its side-effect
 * augmentation imports, and the public entry point must serve working runtime
 * values. Deterministic unit harness — the HTTP boundary is a recording
 * request transport; the module graph itself is real and unmocked.
 */
import { describe, expect, it } from "vitest";
import {
  client,
  ElizaClient,
  parseMeetingStatusEvent,
  parseMeetingTranscriptEvent,
} from "./client";

/** One representative prototype method per augmentation import in client.ts. */
const AUGMENTED_METHODS = {
  "client-agent": "startAgent",
  "client-approvals": "listPendingActions",
  "client-automations": "listAutomations",
  "client-background": "uploadBackgroundImage",
  "client-browser-bridge": "listBrowserBridgeSessions",
  "client-browser-workspace": "getBrowserWorkspace",
  "client-chat": "listConversations",
  "client-cloud": "getCloudStatus",
  "client-computeruse": "getComputerUseApprovals",
  "client-files": "listFiles",
  "client-imessage": "sendIMessage",
  "client-local-inference": "getLocalInferenceHub",
  "client-meetings": "listMeetings",
  "client-notifications": "listNotifications",
  "client-scheduled-tasks": "listScheduledTasks",
  "client-skills": "getSkills",
  "client-transcripts": "listTranscripts",
  "client-vault": "listSavedLogins",
  "client-voice-models": "listVoiceModels",
  "client-wallet": "getWalletBalances",
  "client-workflow": "listWorkflowDefinitions",
} as const;

const AUGMENTATION_ENTRIES = Object.entries(AUGMENTED_METHODS) as Array<
  [keyof typeof AUGMENTED_METHODS, keyof ElizaClient]
>;

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

/** The singleton resolves no base outside a browser; give it one explicitly. */
const SINGLETON_BASE = "http://agent.example:31337";

function recordSingletonRequests(
  body: unknown = { ok: true },
): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  client.setBaseUrl(SINGLETON_BASE, { persist: false });
  client.setRequestTransport({
    request: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return calls;
}

/** Narrows the single recorded request or fails the test loudly. */
function firstCall(calls: RecordedRequest[]): RecordedRequest {
  const call = calls.at(0);
  if (!call) throw new Error("expected one recorded request");
  return call;
}

describe("client.ts composition root", () => {
  it("exports the ElizaClient class and a singleton instance of exactly that class", () => {
    expect(client).toBeInstanceOf(ElizaClient);
    expect(client.constructor).toBe(ElizaClient);
  });

  it("installs every augmentation module's methods on the singleton prototype", () => {
    for (const [augmentation, representative] of AUGMENTATION_ENTRIES) {
      expect(
        typeof client[representative],
        `${augmentation} must install ${String(representative)}()`,
      ).toBe("function");
    }
  });
});

describe("singleton request path (LifeOps scheduled-task verbs)", () => {
  it("listScheduledTasks GETs /api/lifeops/scheduled-tasks and passes the envelope through", async () => {
    const tasks = [{ id: "task-1", kind: "reminder", status: "pending" }];
    const calls = recordSingletonRequests({ tasks });

    await expect(client.listScheduledTasks()).resolves.toEqual({ tasks });

    const req = firstCall(calls);
    expect(req.url).toBe(`${SINGLETON_BASE}/api/lifeops/scheduled-tasks`);
    expect(req.init?.method).toBeUndefined();
  });

  it("listScheduledTasks serialises the filter into the query string", async () => {
    const calls = recordSingletonRequests({ tasks: [] });

    await client.listScheduledTasks({
      kind: "reminder",
      ownerVisibleOnly: true,
    });

    expect(firstCall(calls).url).toBe(
      `${SINGLETON_BASE}/api/lifeops/scheduled-tasks?kind=reminder&ownerVisibleOnly=1`,
    );
  });

  it("listScheduledTasks normalises a missing or non-array tasks field to an empty list", async () => {
    recordSingletonRequests({});
    await expect(client.listScheduledTasks()).resolves.toEqual({ tasks: [] });

    const broken = recordSingletonRequests({ tasks: "nope" });
    await expect(client.listScheduledTasks()).resolves.toEqual({ tasks: [] });
    expect(firstCall(broken).url).toBe(
      `${SINGLETON_BASE}/api/lifeops/scheduled-tasks`,
    );
  });

  it("applyScheduledTask POSTs the JSON payload to /<encoded-id>/<verb>", async () => {
    const task = { id: "t 1" };
    const calls = recordSingletonRequests({ task });

    await expect(
      client.applyScheduledTask("t 1", "snooze", { minutes: 5 }),
    ).resolves.toEqual({ task });

    const req = firstCall(calls);
    expect(req.url).toBe(
      `${SINGLETON_BASE}/api/lifeops/scheduled-tasks/t%201/snooze`,
    );
    expect(req.init?.method).toBe("POST");
    expect(req.init?.body).toBe(JSON.stringify({ minutes: 5 }));
  });

  it("applyScheduledTask sends an empty JSON object when no payload is given", async () => {
    const calls = recordSingletonRequests({ task: { id: "t-2" } });

    await client.applyScheduledTask("t-2", "complete");

    expect(firstCall(calls).init?.body).toBe("{}");
  });

  it("fireScheduledTask POSTs to /<encoded-id>/fire with an empty body and returns the fire outcome", async () => {
    const fire = { kind: "fired", task: { id: "t-3" } };
    const calls = recordSingletonRequests({ fire });

    await expect(client.fireScheduledTask("weird/id")).resolves.toEqual({
      fire,
    });

    const req = firstCall(calls);
    expect(req.url).toBe(
      `${SINGLETON_BASE}/api/lifeops/scheduled-tasks/${encodeURIComponent("weird/id")}/fire`,
    );
    expect(req.init?.method).toBe("POST");
    expect(req.init?.body).toBe("{}");
  });

  it("runLifeOpsTestProbe POSTs /test-probe, defaulting the body to {}", async () => {
    const calls = recordSingletonRequests({
      task: { id: "probe-1" },
      fire: { kind: "raced", task: null },
    });

    await client.runLifeOpsTestProbe();

    expect(firstCall(calls).url).toBe(
      `${SINGLETON_BASE}/api/lifeops/scheduled-tasks/test-probe`,
    );
    expect(firstCall(calls).init?.body).toBe("{}");
  });

  it("runLifeOpsTestProbe forwards the requested probe kind", async () => {
    const calls = recordSingletonRequests({
      task: { id: "probe-2" },
      fire: { kind: "skipped", reason: "gate" },
    });

    await expect(client.runLifeOpsTestProbe("checkin")).resolves.toEqual({
      task: { id: "probe-2" },
      fire: { kind: "skipped", reason: "gate" },
    });

    expect(firstCall(calls).init?.body).toBe(
      JSON.stringify({ kind: "checkin" }),
    );
  });
});

describe("re-exported meeting WebSocket guards via the public entry point", () => {
  it("narrows well-formed envelopes and rejects malformed ones through ./client", () => {
    const confirmed = [{ id: "seg-1", text: "hello" }];

    expect(
      parseMeetingTranscriptEvent({
        type: "meeting-transcript",
        sessionId: "s-1",
        transcriptId: "tr-1",
        confirmed,
        pending: [],
      }),
    ).toEqual({
      type: "meeting-transcript",
      sessionId: "s-1",
      transcriptId: "tr-1",
      confirmed,
      pending: [],
    });
    expect(parseMeetingTranscriptEvent({ type: "other" })).toBeNull();

    expect(
      parseMeetingStatusEvent({
        type: "meeting-status",
        session: { id: "sess-9" },
      }),
    ).toEqual({ type: "meeting-status", session: { id: "sess-9" } });
    expect(parseMeetingStatusEvent({ type: "meeting-status" })).toBeNull();
    expect(
      parseMeetingStatusEvent({ type: "meeting-status", session: null }),
    ).toBeNull();
  });
});
