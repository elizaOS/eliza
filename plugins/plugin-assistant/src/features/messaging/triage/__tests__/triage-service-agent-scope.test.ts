/**
 * Cross-agent isolation for the shared triage message/draft caches.
 *
 * Regression: the process-wide MessageRefStore keyed messages and drafts only
 * by id, so a second runtime agent sharing the TriageService could list the
 * first agent's triaged messages and send its prepared drafts.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { MessageRefStore } from "../message-ref-store.ts";
import { TriageService } from "../triage-service.ts";
import type {
  DraftRecord,
  DraftRequest,
  ListOptions,
  MessageAdapterCapabilities,
  MessageRef,
} from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

const AGENT_B = "00000000-0000-0000-0000-00000000000b" as UUID;

function runtimeFor(agentId?: UUID): IAgentRuntime {
  const runtime = createFakeRuntime();
  return agentId ? ({ ...runtime, agentId } as IAgentRuntime) : runtime;
}

function ref(id: string): MessageRef {
  return {
    id: `gmail:${id}`,
    source: "gmail",
    externalId: id,
    from: { identifier: "someone@example.com" },
    to: [],
    snippet: "hello",
    receivedAtMs: Date.now(),
    hasAttachments: false,
    isRead: false,
  };
}

class DraftingAdapter extends BaseMessageAdapter {
  readonly source = "gmail" as const;
  readonly sent: Array<{ agentId: UUID; draftId: string }> = [];
  constructor(
    private readonly refsByAgent: Map<UUID, MessageRef[]>,
    private readonly draftId = "provider-draft-1",
  ) {
    super();
  }
  isAvailable(): boolean {
    return true;
  }
  capabilities(): MessageAdapterCapabilities {
    return {
      list: true,
      search: false,
      manage: {},
      send: {},
      worlds: "single",
      channels: "none",
    };
  }
  protected listMessagesImpl(
    runtime: IAgentRuntime,
    _opts: ListOptions,
  ): Promise<MessageRef[]> {
    return Promise.resolve(this.refsByAgent.get(runtime.agentId) ?? []);
  }
  protected createDraftImpl(
    _runtime: IAgentRuntime,
    draft: DraftRequest,
  ): Promise<{ draftId: string; preview: string }> {
    return Promise.resolve({ draftId: this.draftId, preview: draft.body });
  }
  protected sendDraftImpl(
    runtime: IAgentRuntime,
    draftId: string,
  ): Promise<{ externalId: string }> {
    this.sent.push({ agentId: runtime.agentId, draftId });
    return Promise.resolve({ externalId: `sent-${draftId}` });
  }
}

function setup() {
  const agentA = runtimeFor();
  const agentB = runtimeFor(AGENT_B);
  const adapter = new DraftingAdapter(
    new Map([
      [agentA.agentId, [ref("a-private")]],
      [agentB.agentId, [ref("b-private")]],
    ]),
  );
  const store = new MessageRefStore();
  const service = new TriageService(store);
  service.register(adapter);
  return { agentA, agentB, adapter, store, service };
}

describe("TriageService agent scoping", () => {
  it("does not expose one agent's triaged messages to another agent", async () => {
    const { agentA, agentB, store, service } = setup();
    await service.triage(agentA, { sources: ["gmail"] });
    expect(store.listMessages(agentA.agentId).map((row) => row.id)).toEqual([
      "gmail:a-private",
    ]);
    expect(store.listMessages(agentB.agentId)).toEqual([]);
    expect(store.getMessage("gmail:a-private", agentB.agentId)).toBeNull();
    expect(service.getAdapterForMessage(agentB, "gmail:a-private")).toBe(
      undefined,
    );
    await expect(
      service.draftReply(agentB, "gmail:a-private", "reply"),
    ).rejects.toThrow("No message found");
  });

  it("refuses to send another agent's draft without calling the adapter", async () => {
    const { agentA, agentB, adapter, service } = setup();
    await service.triage(agentA, { sources: ["gmail"] });
    const draft = await service.draftReply(agentA, "gmail:a-private", "hi");
    expect(service.getDraft(agentB, draft.draftId)).toBeNull();
    await expect(
      service.sendDraft(agentB, draft.draftId),
    ).rejects.toMatchObject({ code: "MESSAGE_DRAFT_NOT_FOUND" });
    expect(adapter.sent).toEqual([]);
  });

  it("keeps the same provider draft id separate per agent", async () => {
    const { agentA, agentB, adapter, service } = setup();
    await service.triage(agentA, { sources: ["gmail"] });
    await service.triage(agentB, { sources: ["gmail"] });
    const draftA = await service.draftReply(
      agentA,
      "gmail:a-private",
      "from A",
    );
    const draftB = await service.draftReply(
      agentB,
      "gmail:b-private",
      "from B",
    );
    expect(draftA.draftId).toBe(draftB.draftId);
    expect(service.getDraft(agentA, draftA.draftId)?.body).toBe("from A");
    expect(service.getDraft(agentB, draftB.draftId)?.body).toBe("from B");
    const sentB = await service.sendDraft(agentB, draftB.draftId);
    expect(sentB.sent).toBe(true);
    expect(service.getDraft(agentA, draftA.draftId)?.sent).toBe(false);
    expect(adapter.sent).toEqual([
      { agentId: agentB.agentId, draftId: draftB.draftId },
    ]);
  });

  it("rejects a persisted snapshot owned by another agent and binds legacy snapshots", async () => {
    const { agentA, agentB, adapter, service } = setup();
    const snapshot: DraftRecord = {
      draftId: "scheduled-1",
      agentId: agentA.agentId,
      source: "gmail",
      to: [{ identifier: "someone@example.com" }],
      body: "scheduled body",
      preview: "scheduled body",
      createdAtMs: Date.now(),
      sent: false,
    };
    await expect(
      service.sendPersistedDraft(agentB, snapshot),
    ).rejects.toMatchObject({ code: "MESSAGE_DRAFT_NOT_FOUND" });
    expect(adapter.sent).toEqual([]);

    const { agentId: _omitted, ...legacy } = snapshot;
    const sent = await service.sendPersistedDraft(agentB, legacy);
    expect(sent.sent).toBe(true);
    expect(sent.agentId).toBe(agentB.agentId);
    expect(adapter.sent).toEqual([
      { agentId: agentB.agentId, draftId: "provider-draft-1" },
    ]);
    expect(service.getDraft(agentA, "provider-draft-1")).toBeNull();
  });
});
