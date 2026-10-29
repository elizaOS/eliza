import { describe, expect, it } from "vitest";
import {
  actionScope,
  type DeviceActionClientProfile,
  DeviceActionCoordinator,
  type DeviceActionJournal,
  type DeviceContextEnvelope,
  type DeviceExecutor,
  type DeviceJournalEntry,
  type DeviceOperationReceipt,
  proposalContextNotice,
  publishCommittedDeviceChanges,
  validateDeviceOperation,
} from "./client-coordinator.ts";

const session = {
  ownerId: "owner",
  agentId: "agent",
  sessionId: "session",
  origin: "https://agent.example",
};
const credential = {
  installationId: "device",
  enrollmentId: "enrollment",
  key: "k".repeat(64),
};
const scope = "c".repeat(64);
const digest = "b".repeat(64);
const notesContext: DeviceContextEnvelope = {
  view: "notes",
  revision: 2,
  sensitive: false,
};
const signal = () => new AbortController().signal;

const profile: DeviceActionClientProfile = {
  appName: "Eliza",
  operations: {
    admitView: (view) => view !== "files",
    parseWorkflowRead: () => {
      throw Error("No workflow reads in this fixture");
    },
  },
  workflow: {
    parseBinding: () => {
      throw Error("No workflow bindings in this fixture");
    },
    parseRead: () => {
      throw Error("No workflow reads in this fixture");
    },
    validateResult: async () => {
      throw Error("No workflow reads in this fixture");
    },
    assertOperation: () => {
      throw Error("No workflow bindings in this fixture");
    },
  },
  presentRecord: (operation) =>
    operation.type === "create_note"
      ? { title: "Save note", description: `Save “${operation.title}”` }
      : undefined,
  browserNavigationSummary: (url) => `Opened ${new URL(url).host}.`,
  mapsSelectionCurrent: () => false,
  namedCalendarReadTarget: () => undefined,
  foregroundHidden: () => false,
};

/**
 * In-memory canonical queue: decision → claim → receipt → owner reconciliation,
 * one attempt per proposal. Like the agent service, a receipt is accepted only
 * while the attempt is executing; a replay to a durable outcome must be
 * identical, and any other state refuses it.
 */
function fixtureServer(operation: Record<string, unknown>, id = "proposal") {
  const server = {
    state: "pending",
    attemptId: undefined as string | undefined,
    receipts: [] as Array<Record<string, unknown>>,
    providerReceipt: undefined as unknown,
    claims: 0,
    receiptOutage: false,
  };
  const proposal = () => ({
    id,
    digest,
    state: server.state,
    subjectUserId: "owner",
    requestedBy: "agent",
    action: "device_action",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    payload: {
      action: "device_action",
      version: 1,
      installationId: "device",
      enrollmentId: "enrollment",
      operation,
    },
    execution: server.attemptId
      ? {
          attemptId: server.attemptId,
          ...(server.providerReceipt === undefined
            ? {}
            : { providerReceipt: server.providerReceipt }),
        }
      : null,
  });
  const request = async (path: string, body: unknown, s: AbortSignal) => {
    s.throwIfAborted();
    if (body === undefined) return { proposals: [proposal()] };
    const data = body as Record<string, unknown>;
    expect(data.digest).toBe(digest);
    if (path.endsWith("/decision"))
      server.state = data.decision === "approve" ? "approved" : "rejected";
    if (path.endsWith("/claim")) {
      server.claims++;
      expect(server.state).toBe("approved");
      server.state = "executing";
      server.attemptId = "attempt";
    }
    if (path.endsWith("/receipt")) {
      if (server.receiptOutage) throw Error("Synthetic outage");
      if (data.attemptId !== server.attemptId)
        throw Error("Execution attempt mismatch");
      if (
        server.state === "done" ||
        server.state === "reconciliation_required"
      ) {
        if (
          JSON.stringify(server.providerReceipt) !==
          JSON.stringify(data.receipt)
        )
          throw Error("Receipt conflicts with durable outcome");
        return { proposal: proposal(), digest };
      }
      if (server.state !== "executing")
        throw Error(`Invalid transition ${server.state} -> receipt`);
      const receipt = data.receipt as { outcome: string };
      server.receipts.push(data);
      server.providerReceipt = data.receipt;
      server.state =
        receipt.outcome === "applied" ? "done" : "reconciliation_required";
    }
    if (path.endsWith("/reconciliation")) {
      if (data.attemptId !== server.attemptId)
        throw Error("Execution attempt mismatch");
      if (server.state !== "reconciliation_required")
        throw Error(`Invalid transition ${server.state} -> reconciliation`);
      const resolution = data.resolution as { outcome: string };
      server.providerReceipt = resolution;
      server.state = resolution.outcome === "applied" ? "done" : "retryable";
    }
    return { proposal: proposal(), digest };
  };
  return { server, request };
}
function memoryJournal() {
  const entries = new Map<string, DeviceJournalEntry>();
  const journal: DeviceActionJournal = {
    async reserve(input) {
      const existing = entries.get(input.proposalId);
      if (existing) return { created: false, entry: existing };
      const entry: DeviceJournalEntry = { ...input, phase: "reserved" };
      entries.set(input.proposalId, entry);
      return { created: true, entry };
    },
    async markApplying(input) {
      const entry = entries.get(input.proposalId);
      expect(entry?.phase).toBe("reserved");
      Object.assign(entry as DeviceJournalEntry, {
        phase: "applying",
        attemptId: input.attemptId,
      });
    },
    async finish(input) {
      const entry = entries.get(input.proposalId);
      expect(entry?.phase).toBe("applying");
      Object.assign(entry as DeviceJournalEntry, input, { phase: "terminal" });
    },
    async get(input) {
      return { entry: entries.get(input.proposalId) ?? null };
    },
    async list() {
      return { entries: [...entries.values()] };
    },
  };
  return { entries, journal };
}
const note = {
  type: "create_note",
  title: "Fixture note",
  body: "Reviewed body",
};

function coordinator(
  request: (p: string, b: unknown, s: AbortSignal) => Promise<unknown>,
  journal: DeviceActionJournal,
  execute: DeviceExecutor,
) {
  return new DeviceActionCoordinator({
    session,
    credential,
    scope,
    request,
    journal,
    execute,
    profile,
  });
}

describe("DeviceActionCoordinator", () => {
  it("reserves the journal before dispatch and uploads the exact receipt", async () => {
    const { server, request } = fixtureServer(note);
    const { entries, journal } = memoryJournal();
    let effects = 0;
    const actions = coordinator(request, journal, async () => {
      expect(entries.get("proposal")?.phase).toBe("applying");
      effects++;
      return { status: "succeeded", summary: "Saved fixture note" };
    });
    const [card] = await actions.pending(notesContext, signal());
    expect(card).toMatchObject({ id: "proposal", title: "Save note" });
    const receipt = await actions.approve("proposal", notesContext, signal());
    expect(receipt).toMatchObject({
      status: "succeeded",
      committedChanges: [],
    });
    expect(effects).toBe(1);
    expect(server.state).toBe("done");
    const entry = entries.get("proposal") as DeviceJournalEntry;
    expect(entry).toMatchObject({ phase: "terminal", status: "succeeded" });
    expect(entry.operationHash).toBe(await actionScope(JSON.stringify(note)));
    expect(server.receipts[0].receipt).toEqual({
      outcome: "applied",
      operationId: entry.operationId,
    });
  });

  it("refuses a second effect when the journal already holds the proposal", async () => {
    const { server, request } = fixtureServer(note);
    const { journal } = memoryJournal();
    let effects = 0;
    const execute: DeviceExecutor = async () => {
      effects++;
      return { status: "succeeded", summary: "Saved" };
    };
    // A previous process reserved this proposal and then disappeared.
    await journal.reserve({
      scope,
      proposalId: "proposal",
      operationId: "earlier",
      operationHash: await actionScope(JSON.stringify(note)),
      record: { digest },
    });
    const actions = coordinator(request, journal, execute);
    await actions.pending(notesContext, signal());
    const receipt = await actions.approve("proposal", notesContext, signal());
    expect(receipt.status).toBe("unknown");
    expect(receipt.summary).toMatch(/already has a device journal entry/);
    expect(effects).toBe(0);
    expect(server.claims).toBe(0);
    // The review is consumed: approving again does not dispatch either.
    await expect(
      actions.approve("proposal", notesContext, signal()),
    ).rejects.toThrow(/Review this action again/);
  });

  it("records an unconfirmed outcome as unknown and never repeats it", async () => {
    const { server, request } = fixtureServer(note);
    const { entries, journal } = memoryJournal();
    let effects = 0;
    const actions = coordinator(request, journal, async () => {
      effects++;
      throw Error("Native bridge lost the reply");
    });
    await actions.pending(notesContext, signal());
    const receipt = await actions.approve("proposal", notesContext, signal());
    expect(receipt.status).toBe("unknown");
    expect(entries.get("proposal")).toMatchObject({
      phase: "terminal",
      status: "unknown",
    });
    expect(server.receipts.at(-1)?.receipt.outcome).toBe("unknown");
    await actions.syncReceipts(signal());
    expect(effects).toBe(1);
  });

  it("recovers a journaled result after a receipt outage without re-executing", async () => {
    const { server, request } = fixtureServer(note);
    const { entries, journal } = memoryJournal();
    let effects = 0;
    const execute: DeviceExecutor = async () => {
      effects++;
      return { status: "succeeded", summary: "Saved fixture note" };
    };
    const first = coordinator(request, journal, execute);
    await first.pending(notesContext, signal());
    server.receiptOutage = true;
    const receipt = await first.approve("proposal", notesContext, signal());
    expect(receipt.summary).toMatch(/Server receipt is pending/);
    expect(server.state).toBe("executing");
    // A fresh coordinator (app restart) replays only the exact journal entry.
    server.receiptOutage = false;
    const restarted = coordinator(request, journal, execute);
    await restarted.syncReceipts(signal());
    expect(effects).toBe(1);
    expect(server.state).toBe("done");
    expect(server.receipts.at(-1)?.receipt.operationId).toBe(
      entries.get("proposal")?.operationId,
    );
    const history = await restarted.conversationReceipts(new Set(), signal());
    expect(history).toEqual([]);
  });

  it("keeps the owner's reconciled outcome instead of replaying a stale receipt", async () => {
    for (const outcome of ["applied", "not_applied"] as const) {
      const { server, request } = fixtureServer(note);
      const { entries, journal } = memoryJournal();
      let effects = 0;
      const actions = coordinator(request, journal, async () => {
        effects++;
        throw Error("Native bridge lost the reply");
      });
      await actions.pending(notesContext, signal());
      expect(
        (await actions.approve("proposal", notesContext, signal())).status,
      ).toBe("unknown");
      expect(server.state).toBe("reconciliation_required");
      // An identical replay while the server awaits review is accepted.
      await actions.syncReceipts(signal());
      await actions.reconcile("proposal", outcome, signal());
      expect(server.state).toBe(outcome === "applied" ? "done" : "retryable");
      const receipts = server.receipts.length;
      await actions.syncReceipts(signal());
      await actions.syncReceipts(signal());
      expect(server.receipts).toHaveLength(receipts);
      expect(server.state).toBe(outcome === "applied" ? "done" : "retryable");
      expect(entries.get("proposal")).toMatchObject({ status: "unknown" });
      expect(effects).toBe(1);
    }
  });

  it("uploads later receipts when an earlier upload is refused", async () => {
    const first = fixtureServer(note, "first");
    const second = fixtureServer(note, "second");
    const route = (path: string) =>
      path.includes("/second/") ? second : first;
    const request = async (path: string, body: unknown, s: AbortSignal) => {
      if (body !== undefined) return route(path).request(path, body, s);
      const [a, b] = await Promise.all([
        first.request(path, body, s),
        second.request(path, body, s),
      ]);
      return {
        proposals: [
          ...(a as { proposals: unknown[] }).proposals,
          ...(b as { proposals: unknown[] }).proposals,
        ],
      };
    };
    const { journal } = memoryJournal();
    let effects = 0;
    const actions = coordinator(request, journal, async () => {
      effects++;
      return { status: "succeeded", summary: "Saved" };
    });
    await actions.pending(notesContext, signal());
    first.server.receiptOutage = true;
    second.server.receiptOutage = true;
    await actions.approve("first", notesContext, signal());
    await actions.approve("second", notesContext, signal());
    expect([first.server.state, second.server.state]).toEqual([
      "executing",
      "executing",
    ]);
    // The first upload is still refused; the second must not wait behind it.
    second.server.receiptOutage = false;
    await expect(actions.syncReceipts(signal())).rejects.toThrow(
      /Synthetic outage/,
    );
    expect(second.server.state).toBe("done");
    first.server.receiptOutage = false;
    await actions.syncReceipts(signal());
    expect(first.server.state).toBe("done");
    expect(effects).toBe(2);
  });

  it("binds approval to the exact screen it was reviewed on", async () => {
    const { server, request } = fixtureServer(note);
    const { journal } = memoryJournal();
    const actions = coordinator(request, journal, async () => ({
      status: "succeeded",
      summary: "Saved",
    }));
    await actions.pending(notesContext, signal());
    await expect(
      actions.approve("proposal", { ...notesContext, revision: 3 }, signal()),
    ).rejects.toThrow(/current screen/);
    await expect(
      actions.approve(
        "proposal",
        { ...notesContext, sensitive: true },
        signal(),
      ),
    ).rejects.toThrow(/current screen/);
    expect(server.claims).toBe(0);
  });

  it("cancellation before dispatch reports unknown without an effect", async () => {
    const { request } = fixtureServer(note);
    const { entries, journal } = memoryJournal();
    let effects = 0;
    const actions = coordinator(request, journal, async () => {
      effects++;
      return { status: "succeeded", summary: "Saved" };
    });
    await actions.pending(notesContext, signal());
    const controller = new AbortController();
    controller.abort();
    const receipt = await actions.approve(
      "proposal",
      notesContext,
      controller.signal,
    );
    expect(receipt.status).toBe("unknown");
    expect(effects).toBe(0);
    // A retired attempt never reaches the journal or the server claim.
    expect(entries.get("proposal")).toBeUndefined();
  });

  it("refuses operations whose capability was not negotiated", async () => {
    const { request } = fixtureServer({ type: "camera_capture_photo" });
    const { journal } = memoryJournal();
    const actions = coordinator(request, journal, async () => ({
      status: "succeeded",
      summary: "",
    }));
    const review = await actions.pendingReview(
      { view: "camera", revision: 1, sensitive: false },
      signal(),
    );
    expect(review).toHaveLength(1);
    expect(review[0].proposal).toBeNull();
    expect(review[0].notice).toMatch(/Camera capture was not negotiated/);
  });

  it("applies the product view admission policy", () => {
    expect(
      validateDeviceOperation(
        { type: "open_view", view: "notes" },
        profile.operations,
      ),
    ).toEqual({ type: "open_view", view: "notes" });
    expect(() =>
      validateDeviceOperation(
        { type: "open_view", view: "files" },
        profile.operations,
      ),
    ).toThrow(/Unsupported/);
    expect(() =>
      validateDeviceOperation(
        { type: "browser_navigate", url: "http://example.com" },
        profile.operations,
      ),
    ).toThrow(/browser destination/);
    expect(
      proposalContextNotice(
        { type: "camera_capture_photo" } as never,
        notesContext,
        profile,
      ),
    ).toBe("Open Camera to take the requested photo.");
  });
});

describe("publishCommittedDeviceChanges", () => {
  it("publishes only for the same idle session", () => {
    let pending = true;
    const listeners = new Set<() => void>();
    const client = {
      getState: () => ({ connection: "ready", pending, session }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const published: string[] = [];
    const receipt: DeviceOperationReceipt = {
      proposalId: "p",
      status: "succeeded",
      summary: "",
      committedChanges: ["notes", "notes", "calendar"],
    };
    publishCommittedDeviceChanges(receipt, client, session, (view) =>
      published.push(view),
    );
    expect(published).toEqual([]);
    pending = false;
    for (const listener of [...listeners]) listener();
    expect(published).toEqual(["notes", "calendar"]);
    expect(listeners.size).toBe(0);
    publishCommittedDeviceChanges(receipt, client, session, (view) =>
      published.push(view),
    );
    expect(published).toEqual(["notes", "calendar"]);
  });
});
