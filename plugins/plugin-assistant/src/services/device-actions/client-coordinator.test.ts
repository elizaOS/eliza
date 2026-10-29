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

/** In-memory canonical queue: decision → claim → receipt, one attempt per proposal. */
function fixtureServer(operation: Record<string, unknown>) {
  const server = {
    state: "pending",
    attemptId: undefined as string | undefined,
    receipts: [] as Array<Record<string, any>>,
    claims: 0,
    receiptOutage: false,
  };
  const proposal = () => ({
    id: "proposal",
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
          ...(server.receipts.length
            ? { providerReceipt: server.receipts.at(-1)?.receipt }
            : {}),
        }
      : null,
  });
  const request = async (path: string, body: unknown, s: AbortSignal) => {
    s.throwIfAborted();
    if (body === undefined) return { proposals: [proposal()] };
    const data = body as Record<string, any>;
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
      expect(data.attemptId).toBe("attempt");
      server.receipts.push(data);
      server.state =
        data.receipt.outcome === "applied" ? "done" : "reconciliation_required";
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
