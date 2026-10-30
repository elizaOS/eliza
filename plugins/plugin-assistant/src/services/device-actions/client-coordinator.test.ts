import { describe, expect, it } from "vitest";
import {
  actionScope,
  type CurrentDeviceActionRequest,
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
import {
  validateWorkflowBinding,
  validateWorkflowReadOperation,
  validateWorkflowReadResult,
} from "./workflow-contract.ts";

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
function fixtureServer(
  operation: Record<string, unknown>,
  id = "proposal",
  workflow?: Record<string, unknown>,
) {
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
      ...(workflow ? { workflow } : {}),
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
  currentRequestBrowserPolicy = false,
) {
  return new DeviceActionCoordinator(
    {
      session,
      credential,
      scope,
      request,
      journal,
      execute,
      profile,
    },
    { currentRequestBrowserPolicy },
  );
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

describe("opt-in current browser request policy", () => {
  const context: DeviceContextEnvelope = {
    view: "browser",
    revision: 1,
    sensitive: false,
  };
  const proof = (
    text = "open https://example.com/path?q=1#x",
  ): CurrentDeviceActionRequest => ({
    messageId: "message",
    text,
    current() {},
  });
  function browserFixture(policy = true, reserveGate?: () => Promise<void>) {
    const fixture = fixtureServer({
      type: "browser_navigate",
      url: "https://example.com/path?q=1#x",
    });
    let messageId: string | undefined = "message";
    let proposalId = "proposal",
      proposalDigest = digest;
    const request = async (path: string, body: unknown, s: AbortSignal) => {
      const response = await fixture.request(path, body, s);
      if ("proposals" in response)
        for (const item of response.proposals) {
          Object.assign(item.payload, { requestMessageId: messageId });
          Object.assign(item, { id: proposalId, digest: proposalDigest });
        }
      if ("proposal" in response) {
        Object.assign(response.proposal.payload, {
          requestMessageId: messageId,
        });
        Object.assign(response.proposal, {
          id: proposalId,
          digest: proposalDigest,
        });
      }
      return response;
    };
    const { journal, entries } = memoryJournal();
    const reserve = journal.reserve.bind(journal);
    journal.reserve = async (input) => {
      if (reserveGate) await reserveGate();
      return reserve(input);
    };
    let effects = 0;
    const actions = coordinator(
      request,
      journal,
      async () => {
        effects++;
        return { status: "succeeded", summary: "Opened" };
      },
      policy,
    );
    return {
      ...fixture,
      actions,
      entries,
      effects: () => effects,
      bind(message: string | undefined, id = "proposal", nextDigest = digest) {
        messageId = message;
        proposalId = id;
        proposalDigest = nextDigest;
      },
    };
  }
  it("blocks mismatched destinations for the same current request with validated provenance", async () => {
    const f = browserFixture();
    for (const current of [
      proof("read my calendar"),
      proof("open example.com"),
    ]) {
      expect(
        await f.actions.pendingReview(context, signal(), current),
      ).toMatchObject([
        {
          proposal: null,
          proposalId: "proposal",
          notice: expect.stringContaining("blocked"),
        },
      ]);
    }
    expect(f.server.state).toBe("pending");
    expect(f.server.claims).toBe(0);
    expect(f.effects()).toBe(0);
  });
  it("keeps missing-proof, unbound and old browser proposals manual-only", async () => {
    for (const kind of ["missing-proof", "unbound", "old"] as const) {
      const f = browserFixture();
      if (kind === "unbound") f.bind(undefined);
      if (kind === "old") f.bind("old-message");
      const current = kind === "missing-proof" ? undefined : proof();
      expect(
        await f.actions.pendingReview(context, signal(), current),
      ).toMatchObject([
        { proposalId: "proposal", proposal: { id: "proposal" } },
      ]);
      expect(
        await f.actions.performRequested(
          "message",
          context,
          signal(),
          async () => true,
          undefined,
          current,
        ),
      ).toEqual([]);
      expect(f.effects()).toBe(0);
      expect(f.server.state).toBe("pending");
      expect(
        await f.actions.approve("proposal", context, signal()),
      ).toMatchObject({ status: "succeeded" });
      expect(f.effects()).toBe(1);
    }
  });
  it("throws for a stale supplied proof before listing", async () => {
    const fixture = fixtureServer(note);
    const { journal } = memoryJournal();
    let requests = 0;
    const actions = coordinator(
      async (...args) => {
        requests++;
        return fixture.request(...args);
      },
      journal,
      async () => ({ status: "succeeded", summary: "Saved" }),
      true,
    );
    await expect(
      actions.pendingReview(context, signal(), {
        ...proof(),
        current() {
          throw Error("retired");
        },
      }),
    ).rejects.toThrow("retired");
    expect(requests).toBe(0);
  });
  for (const invalidation of ["request", "session"] as const) {
    it(`throws when ${invalidation} changes during listing`, async () => {
      const fixture = fixtureServer(note);
      const { journal } = memoryJournal();
      let active = true;
      const previous = session.sessionId;
      const current = {
        ...proof(),
        current() {
          if (!active) throw Error("retired");
        },
      };
      const actions = coordinator(
        async (...args) => {
          const response = await fixture.request(...args);
          if (invalidation === "request") active = false;
          else session.sessionId = "rebound-during-list";
          return response;
        },
        journal,
        async () => ({ status: "succeeded", summary: "Saved" }),
        true,
      );
      try {
        await expect(
          actions.pendingReview(context, signal(), current),
        ).rejects.toThrow(
          invalidation === "request"
            ? "retired"
            : "current device action request changed",
        );
      } finally {
        session.sessionId = previous;
      }
      expect(fixture.server.claims).toBe(0);
      expect(fixture.server.state).toBe("pending");
    });
  }
  it("does not attach unvalidated IDs to malformed sibling notices", async () => {
    const fixture = fixtureServer(note);
    const { journal } = memoryJournal();
    const actions = coordinator(
      async (path, body, s) => {
        const response = await fixture.request(path, body, s);
        if ("proposals" in response)
          response.proposals.push({
            ...response.proposals[0],
            id: "untrusted",
            subjectUserId: "other-owner",
          });
        return response;
      },
      journal,
      async () => ({ status: "succeeded", summary: "Saved" }),
      true,
    );
    const items = await actions.pendingReview(notesContext, signal());
    expect(items[0]).toMatchObject({
      proposalId: "proposal",
      proposal: { id: "proposal" },
    });
    expect(items[1].proposal).toBeNull();
    expect(items[1]).not.toHaveProperty("proposalId");
  });
  it("accepts quoted explicit destinations and preserves path, query and fragment grounding", async () => {
    for (const text of [
      'open "https://example.com/path?q=1#x"',
      "https://example.com/path?q=1#x",
      "visit example.com/path?q=1#x",
    ]) {
      const f = browserFixture();
      const current = proof(text);
      expect(
        (await f.actions.pendingReview(context, signal(), current))[0].proposal
          ?.id,
      ).toBe("proposal");
      expect(
        await f.actions.performRequested(
          "message",
          context,
          signal(),
          async () => true,
          undefined,
          current,
        ),
      ).toHaveLength(1);
    }
  });
  it("grounds the exact destination and consumes once before concurrent approval", async () => {
    const f = browserFixture();
    const current = proof();
    expect(
      await f.actions.pendingReview(context, signal(), current),
    ).toMatchObject([{ proposalId: "proposal", proposal: { id: "proposal" } }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt = () =>
      f.actions.performRequested(
        "message",
        context,
        signal(),
        async () => {
          await gate;
          return true;
        },
        "browser_navigate",
        current,
      );
    const a = attempt(),
      b = attempt();
    release();
    const receipts = await Promise.all([a, b]);
    expect(receipts.flat()).toHaveLength(1);
    expect(f.effects()).toBe(1);
    expect(f.server.claims).toBe(1);
  });
  it("rechecks cancellation and current authority after asynchronous preference", async () => {
    const f = browserFixture();
    let active = true;
    const current = {
      ...proof(),
      current() {
        if (!active) throw Error("retired");
      },
    };
    await f.actions.pendingReview(context, signal(), current);
    await expect(
      f.actions.performRequested(
        "message",
        context,
        signal(),
        async () => {
          active = false;
          return true;
        },
        undefined,
        current,
      ),
    ).rejects.toThrow("retired");
    expect(f.server.state).toBe("pending");
    expect(f.effects()).toBe(0);
  });
  it("throws for already aborted or retired matching automatic requests", async () => {
    const f = browserFixture();
    let active = true;
    const current = {
      ...proof(),
      current() {
        if (!active) throw Error("retired matching request");
      },
    };
    await f.actions.pendingReview(context, signal(), current);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      f.actions.performRequested(
        "message",
        context,
        aborted.signal,
        async () => true,
        undefined,
        current,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    active = false;
    await expect(
      f.actions.performRequested(
        "message",
        context,
        signal(),
        async () => true,
        undefined,
        current,
      ),
    ).rejects.toThrow("retired matching request");
    expect(f.effects()).toBe(0);
    expect(f.server.state).toBe("pending");
  });
  it("preserves the legacy five-argument automatic browser caller", async () => {
    const f = browserFixture(false);
    await f.actions.pendingReview(context, signal());
    expect(
      await f.actions.performRequested(
        "message",
        context,
        signal(),
        async () => true,
        "browser_navigate",
      ),
    ).toHaveLength(1);
    expect(f.effects()).toBe(1);
  });
  it("keeps once markers across A to B to A and refuses a full live ledger", async () => {
    const f = browserFixture();
    let firstRetired = false;
    for (let i = 0; i < 128; i++) {
      const messageId = `message-${i}`;
      f.bind(messageId, `proposal-${i}`);
      f.server.state = "pending";
      const current = {
        ...proof(),
        messageId,
        current() {
          if (i === 0 && firstRetired) throw Error("retired");
        },
      };
      await f.actions.pendingReview(context, signal(), current);
      await f.actions.performRequested(
        messageId,
        context,
        signal(),
        async () => true,
        undefined,
        current,
      );
    }
    expect(f.effects()).toBe(128);
    for (const messageId of ["message-0", "message-128"]) {
      f.bind(messageId, `new-${messageId}`);
      f.server.state = "pending";
      const current = { ...proof(), messageId };
      await f.actions.pendingReview(context, signal(), current);
      expect(
        await f.actions.performRequested(
          messageId,
          context,
          signal(),
          async () => true,
          undefined,
          current,
        ),
      ).toEqual([]);
    }
    expect(f.effects()).toBe(128);
    firstRetired = true;
    const current = { ...proof(), messageId: "after-retirement" };
    f.bind(current.messageId, "after-retirement");
    f.server.state = "pending";
    await f.actions.pendingReview(context, signal(), current);
    expect(
      await f.actions.performRequested(
        current.messageId,
        context,
        signal(),
        async () => true,
        undefined,
        current,
      ),
    ).toHaveLength(1);
    expect(f.effects()).toBe(129);
  });
  it("reevaluates changed proposal digests", async () => {
    const f = browserFixture();
    const current = proof("open https://other.example");
    expect(
      (await f.actions.pendingReview(context, signal(), current))[0].proposal,
    ).toBeNull();
    f.bind("message", "proposal", "d".repeat(64));
    expect(
      (await f.actions.pendingReview(context, signal(), proof()))[0].proposal
        ?.id,
    ).toBe("proposal");
  });
  it("refuses session rebinding or abort during preference checks", async () => {
    const f = browserFixture();
    const current = proof();
    await f.actions.pendingReview(context, signal(), current);
    const previous = session.sessionId;
    try {
      session.sessionId = "already-rebound";
      expect(
        await f.actions.performRequested(
          "message",
          context,
          signal(),
          async () => true,
          undefined,
          current,
        ),
      ).toEqual([]);
      session.sessionId = previous;
      expect(
        await f.actions.performRequested(
          "message",
          context,
          signal(),
          async () => {
            session.sessionId = "new-session";
            return true;
          },
          undefined,
          current,
        ),
      ).toEqual([]);
    } finally {
      session.sessionId = previous;
    }
    const abort = new AbortController();
    await expect(
      f.actions.performRequested(
        "message",
        context,
        abort.signal,
        async () => {
          abort.abort();
          return true;
        },
        undefined,
        current,
      ),
    ).rejects.toThrow();
    expect(f.effects()).toBe(0);
  });
  for (const invalidation of ["request", "session"] as const) {
    it(`refuses dispatch when ${invalidation} changes while journal reservation awaits`, async () => {
      let entered!: () => void;
      let release!: () => void;
      const reserved = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = browserFixture(true, async () => {
        entered();
        await gate;
      });
      let active = true;
      const current = {
        ...proof(),
        current() {
          if (!active) throw Error("retired request");
        },
      };
      await f.actions.pendingReview(context, signal(), current);
      const attempt = f.actions.performRequested(
        "message",
        context,
        signal(),
        async () => true,
        undefined,
        current,
      );
      await reserved;
      const previous = session.sessionId;
      try {
        if (invalidation === "request") active = false;
        else session.sessionId = "replacement-session";
        release();
        expect(await attempt).toMatchObject([
          { proposalId: "proposal", status: "unknown" },
        ]);
        expect(f.effects()).toBe(0);
        expect(f.server.claims).toBe(0);
        expect(f.server.state).toBe("pending");
        expect(f.entries.get("proposal")?.phase).toBe("reserved");
      } finally {
        session.sessionId = previous;
      }
    });
  }
  it("retains a completed effect but skips stale foreground presentation after receipt upload", async () => {
    const fixture = fixtureServer({
      type: "browser_navigate",
      url: "https://example.com/path?q=1#x",
    });
    const { journal } = memoryJournal();
    let active = true,
      presented = 0,
      effects = 0;
    const current = {
      ...proof(),
      current() {
        if (!active) throw Error("retired request");
      },
    };
    const actions = coordinator(
      async (path, body, s) => {
        if (path.endsWith("/receipt")) active = false;
        const response = await fixture.request(path, body, s);
        if ("proposals" in response)
          for (const item of response.proposals)
            Object.assign(item.payload, { requestMessageId: "message" });
        return response;
      },
      journal,
      async () => {
        effects++;
        return {
          status: "succeeded",
          summary: "Opened",
          presentBrowser() {
            presented++;
          },
        };
      },
      true,
    );
    await actions.pendingReview(context, signal(), current);
    expect(
      await actions.performRequested(
        "message",
        context,
        signal(),
        async () => true,
        undefined,
        current,
      ),
    ).toMatchObject([{ status: "succeeded" }]);
    expect(effects).toBe(1);
    expect(presented).toBe(0);
    expect(fixture.server.state).toBe("done");
  });
  it("strips only calendarDay from the durable context and retains full live context", async () => {
    const f = fixtureServer(note);
    const { entries, journal } = memoryJournal();
    const full = {
      ...notesContext,
      calendarDay: { date: "2026-10-29" },
      extraField: { retained: true },
    };
    const actions = coordinator(f.request, journal, async (_op, _id, live) => {
      expect(live).toEqual(full);
      return { status: "succeeded", summary: "Saved" };
    });
    await actions.pending(full, signal());
    await actions.approve("proposal", full, signal());
    expect(entries.get("proposal")?.record.context).toEqual({
      ...notesContext,
      extraField: { retained: true },
    });
  });
});

describe("shared phone and reminder-read parity", () => {
  const home = { view: "home", revision: 3, sensitive: false };
  const dial = {
    type: "phone_dial",
    target: { kind: "number", number: "+15551234567" },
  } as const;
  const dialResult = {
    kind: "phone-dial",
    status: "handed-off",
    handler: "system.dialer",
    contact: false,
  } as const;
  const make = (
    request: (p: string, b: unknown, s: AbortSignal) => Promise<unknown>,
    journal: DeviceActionJournal,
    execute: DeviceExecutor,
    capabilities = ["phone.dial.v1"],
  ) =>
    new DeviceActionCoordinator({
      session,
      credential: { ...credential, capabilities },
      scope,
      request,
      journal,
      execute,
      profile,
    });
  it("negotiates the dial handoff and journals/replays the exact result without dialing twice", async () => {
    const { server, request } = fixtureServer(dial);
    const { journal, entries } = memoryJournal();
    let effects = 0;
    const execute: DeviceExecutor = async () => {
      effects++;
      expect(entries.get("proposal")?.phase).toBe("applying");
      return { status: "succeeded", summary: "Opened dial screen", dialResult };
    };
    const actions = make(request, journal, execute);
    const [card] = await actions.pending(home, signal());
    expect(card.title).toBe("Open dial screen");
    expect(card.description).toContain("+15551234567");
    server.receiptOutage = true;
    expect((await actions.approve("proposal", home, signal())).status).toBe(
      "succeeded",
    );
    expect(entries.get("proposal")?.result?.dialResult).toEqual(dialResult);
    server.receiptOutage = false;
    await make(request, journal, execute).syncReceipts(signal());
    expect(server.receipts[0].receipt).toMatchObject({
      outcome: "applied",
      result: dialResult,
    });
    expect(effects).toBe(1);
  });
  it("refuses unnegotiated contact lookup and hides dialing on a locked screen", async () => {
    const { request } = fixtureServer({
      type: "phone_dial",
      target: { kind: "contact", query: "Alex" },
    });
    const { journal } = memoryJournal();
    let effects = 0;
    const actions = make(request, journal, async () => {
      effects++;
      return { status: "unknown", summary: "not dispatched" };
    });
    await expect(actions.pending(home, signal())).rejects.toThrow(/negotiated/);
    expect(
      proposalContextNotice(dial, { ...home, sensitive: true }, profile),
    ).toMatch(/Unlock/);
    expect(effects).toBe(0);
  });
  it("does not reconcile an unknown dial handoff from the owner's guess", async () => {
    const { request } = fixtureServer(dial);
    const { journal } = memoryJournal();
    let effects = 0;
    const actions = make(request, journal, async () => {
      effects++;
      throw Error("lost result");
    });
    await actions.pending(home, signal());
    expect((await actions.approve("proposal", home, signal())).status).toBe(
      "unknown",
    );
    await expect(
      actions.reconcile("proposal", "applied", signal()),
    ).rejects.toThrow(/exact saved handoff/);
    await expect(
      actions.reconcile("proposal", "not_applied", signal()),
    ).rejects.toThrow(/exact saved handoff/);
    expect(effects).toBe(1);
  });
  it("requires a workflow and validates/replays selected reminder reads without rereading", async () => {
    const operation = {
      type: "read_selected_reminders",
      window: "open_and_completed_today",
      day: "2026-10-08",
      timeZone: "America/Los_Angeles",
      maximumItems: 3,
    };
    const workflow = {
      workflowId: "wf-1",
      versionId: "ver-1",
      runId: "run-1",
      stepId: "reminders",
      specDigest: "a".repeat(64),
    };
    const readResult = { kind: "reminders", reminders: [] } as const;
    const workflowProfile: DeviceActionClientProfile = {
      ...profile,
      operations: {
        ...profile.operations,
        parseWorkflowRead: validateWorkflowReadOperation,
      },
      workflow: {
        ...profile.workflow,
        parseBinding: validateWorkflowBinding,
        parseRead: validateWorkflowReadOperation,
        validateResult: async (op, value) =>
          validateWorkflowReadResult(op, value),
        assertOperation: (_review, binding) => {
          expect(binding).toEqual(workflow);
        },
      },
    };
    const { journal } = memoryJournal();
    let reads = 0;
    const execute: DeviceExecutor = async () => {
      reads++;
      return {
        status: "succeeded",
        summary: "Read selected reminders",
        readResult: { ...readResult, reminders: [] },
      };
    };
    const standalone = fixtureServer(operation);
    const unbound = new DeviceActionCoordinator({
      session,
      credential,
      scope,
      request: standalone.request,
      journal,
      execute,
      profile: workflowProfile,
    });
    await expect(unbound.pending(home, signal())).rejects.toThrow(
      /Workflow binding/,
    );
    const { request, server } = fixtureServer(operation, "proposal", workflow);
    const actions = new DeviceActionCoordinator({
      session,
      credential,
      scope,
      request,
      journal,
      execute,
      profile: workflowProfile,
    });
    const review = {
      ...workflow,
      finished: false,
      cancellationRequestedAt: null,
    };
    const workflowContext = {
      view: "workflows",
      revision: 3,
      selectedObject: {
        kind: "workflow-run",
        id: workflow.runId,
        revision: workflow.versionId,
      },
    };
    const [card] = await actions.pendingForWorkflow(
      review,
      workflowContext,
      signal(),
    );
    expect(card.reviewScope).toContain("At most 3 reminders");
    server.receiptOutage = true;
    expect(
      (await actions.approve("proposal", workflowContext, signal())).status,
    ).toBe("succeeded");
    server.receiptOutage = false;
    await actions.syncReceipts(signal(), workflow);
    expect(server.receipts[0].receipt).toMatchObject({
      outcome: "applied",
      result: readResult,
    });
    expect(reads).toBe(1);
  });
});
