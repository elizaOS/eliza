import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
  registerDeferredMessageScheduler,
} from "@elizaos/plugin-assistant";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedGmailAdapter } from "../src/inbox/managed-gmail-adapter.ts";
import { inboxPlugin } from "../src/plugin.ts";

const access = vi.hoisted(() => ({ allowed: true }));
vi.mock("@elizaos/core", async (original) => ({
  ...(await original<typeof import("@elizaos/core")>()),
  hasRoleAccess: vi.fn(async () => access.allowed),
}));

describe("managed Gmail owner boundary", () => {
  beforeEach(() => {
    __resetDefaultTriageServiceForTests();
    access.allowed = true;
    vi.stubEnv(
      "ELIZA_MANAGED_GMAIL_READ_BROKER",
      "http://127.0.0.1:5209/__alpha-owner-gmail",
    );
    vi.stubEnv("ELIZA_API_TOKEN", "a".repeat(64));
  });
  it("keeps mailbox changes off by default even when the operation broker is configured", async () => {
    vi.stubEnv(
      "ELIZA_MANAGED_GMAIL_OPERATION_BROKER",
      "http://127.0.0.1:5209/__alpha-owner-gmail",
    );
    vi.stubEnv("ELIZA_MANAGED_GMAIL_MAILBOX_CHANGES_ENABLED", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runtime = { agentId: "owned-agent" } as IAgentRuntime;
    const requester = {
      id: "owner-turn",
      agentId: "owned-agent",
      entityId: "owner",
      roomId: "owner-room",
    } as Memory;
    const adapter = new ManagedGmailAdapter();
    expect(adapter.capabilities().manage).toEqual({});
    await expect(
      adapter.manageMessage(
        runtime,
        `alpha-gmail:${"b".repeat(64)}:mail1`,
        { kind: "trash" },
        { requester },
      ),
    ).rejects.toMatchObject({ code: "MANAGED_GMAIL_MAILBOX_UNAVAILABLE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("binds mailbox changes to the trusted owner turn and preserves the operation ID on replay", async () => {
    vi.stubEnv(
      "ELIZA_MANAGED_GMAIL_OPERATION_BROKER",
      "http://127.0.0.1:5209/__alpha-owner-gmail",
    );
    vi.stubEnv("ELIZA_MANAGED_GMAIL_MAILBOX_CHANGES_ENABLED", "1");
    const calls: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const mailbox = JSON.parse(String(init?.body)).mailbox;
      calls.push(mailbox);
      return Response.json({ mailbox: { ...mailbox, ok: true } });
    });
    const runtime = { agentId: "owned-agent" } as IAgentRuntime;
    const requester = {
      id: "owner-turn",
      agentId: "owned-agent",
      entityId: "owner",
      roomId: "owner-room",
    } as Memory;
    const adapter = new ManagedGmailAdapter(),
      messageId = `alpha-gmail:${"b".repeat(64)}:mail1`;
    await expect(
      adapter.manageMessage(runtime, messageId, { kind: "archive" }),
    ).rejects.toThrow("current owner");
    expect(calls).toHaveLength(0);
    access.allowed = false;
    await expect(
      adapter.manageMessage(
        runtime,
        messageId,
        { kind: "trash" },
        { requester },
      ),
    ).rejects.toThrow("restricted to its owner");
    expect(calls).toHaveLength(0);
    access.allowed = true;
    expect(
      await adapter.manageMessage(
        runtime,
        messageId,
        { kind: "archive" },
        { requester },
      ),
    ).toEqual({ ok: true });
    expect(
      await adapter.manageMessage(
        runtime,
        messageId,
        { kind: "archive" },
        { requester },
      ),
    ).toEqual({ ok: true });
    expect(calls[0].requestId).toBe(calls[1].requestId);
    await adapter.manageMessage(
      runtime,
      messageId,
      { kind: "archive" },
      { requester: { ...requester, id: "another-turn" } as Memory },
    );
    expect(calls[2].requestId).not.toBe(calls[0].requestId);
    expect(
      await adapter.manageMessage(
        runtime,
        messageId,
        { kind: "label_add", label: "deferred" },
        { requester },
      ),
    ).toMatchObject({ ok: false });
    expect(calls).toHaveLength(3);
  });
  it("refuses Gmail drafts with a typed error and no host call when sending is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = new ManagedGmailAdapter();
    expect(adapter.capabilities().send).toEqual({
      requiresLiveRequester: true,
    });
    await expect(
      adapter.createDraft(
        { agentId: "owned-agent" } as IAgentRuntime,
        {
          source: "gmail",
          to: [{ identifier: "self@example.invalid" }],
          subject: "QA",
          body: "Text",
        },
        {
          requester: {
            id: "owner-turn",
            agentId: "owned-agent",
            entityId: "owner",
            roomId: "owner-room",
          } as Memory,
        },
      ),
    ).rejects.toMatchObject({ code: "MANAGED_GMAIL_SEND_UNAVAILABLE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("prepares and dispatches only the reviewed owner draft and resolves a lost response by receipt", async () => {
    vi.stubEnv(
      "ELIZA_MANAGED_GMAIL_SEND_BROKER",
      "http://127.0.0.1:5209/__alpha-owner-gmail",
    );
    let dispatches = 0,
      accepted = false,
      id = "",
      digest = "a".repeat(64);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const input = JSON.parse(String(init?.body)).send;
      const receipt = () => ({
        requestId: (input.id ?? id).split(":").at(-1),
        kind: "send",
        state: accepted ? "succeeded" : "prepared",
        reviewDigest: digest,
        providerResult: accepted ? { messageId: "provider-accepted" } : null,
      });
      if (input.operation === "prepare") {
        id = `alpha-gmail-send:${"b".repeat(64)}:${input.requestId}`;
        return Response.json({
          send: {
            id,
            reviewDigest: digest,
            receipt: receipt(),
            review: {
              from: "owner@example.invalid",
              to: input.to,
              subject: input.subject,
              bodyText: input.bodyText,
            },
          },
        });
      }
      if (input.operation === "dispatch") {
        dispatches++;
        accepted = true;
        throw Error("Lost response after provider acceptance");
      }
      return Response.json({ send: receipt() });
    });
    const runtime = {
        agentId: "owned-agent",
        getCache: async () => undefined,
      } as unknown as IAgentRuntime,
      requester = {
        agentId: "owned-agent",
        entityId: "owner",
        roomId: "owner-room",
      } as Memory;
    const snapshot = {
      source: "gmail" as const,
      to: [{ identifier: "self@example.invalid" }],
      subject: "QA",
      body: "Exact reviewed text",
    };
    const adapter = new ManagedGmailAdapter(),
      service = getDefaultTriageService();
    service.register(adapter);
    const draft = await service.draftFollowup(runtime, {
      ...snapshot,
      requester,
    });
    expect(Object.hasOwn(draft, "requester")).toBe(false);
    expect(dispatches).toBe(0);
    // New reviews must not evict an older pending draft or its send receipt binding.
    for (let index = 0; index < 100; index++) {
      await service.draftFollowup(runtime, {
        ...snapshot,
        subject: `Later review ${index}`,
        requester,
      });
    }
    await expect(
      adapter.sendDraft(runtime, draft.draftId, {
        requester,
        snapshot: { ...snapshot, body: "Changed" },
      }),
    ).rejects.toThrow("changed after");
    await expect(
      adapter.sendDraft(runtime, draft.draftId, {
        requester: { ...requester, entityId: "someone-else" },
        snapshot,
      }),
    ).rejects.toThrow("owner conversation");
    await expect(
      service.sendDraft(runtime, draft.draftId, undefined, requester),
    ).resolves.toMatchObject({
      sent: true,
      sentExternalId: "provider-accepted",
    });
    await expect(
      adapter.sendDraft(runtime, draft.draftId, { requester, snapshot }),
    ).resolves.toEqual({ externalId: "provider-accepted" });
    expect(dispatches).toBe(1);
    access.allowed = false;
    await expect(
      service.sendDraft(runtime, draft.draftId, undefined, requester),
    ).rejects.toThrow("restricted to its owner");
  });
  afterEach(() => {
    __resetDefaultTriageServiceForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("refuses to schedule a managed Gmail draft before any durable task is created", async () => {
    vi.stubEnv(
      "ELIZA_MANAGED_GMAIL_SEND_BROKER",
      "http://127.0.0.1:5209/__alpha-owner-gmail",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const input = JSON.parse(String(init?.body)).send;
      return Response.json({
        send: {
          id: `alpha-gmail-send:${"b".repeat(64)}:${input.requestId}`,
          reviewDigest: "a".repeat(64),
          receipt: {
            requestId: input.requestId,
            kind: "send",
            state: "prepared",
            reviewDigest: "a".repeat(64),
            providerResult: null,
          },
          review: {
            from: "owner@example.invalid",
            to: input.to,
            subject: input.subject,
            bodyText: input.bodyText,
          },
        },
      });
    });
    const runtime = {
        agentId: "owned-agent",
        getCache: async () => undefined,
      } as unknown as IAgentRuntime,
      requester = {
        agentId: "owned-agent",
        entityId: "owner",
        roomId: "owner-room",
      } as Memory;
    const schedule = vi.fn(async () => {
      throw new Error("durable scheduler must not be reached");
    });
    const dispose = registerDeferredMessageScheduler(runtime, { schedule });
    try {
      const service = getDefaultTriageService();
      service.register(new ManagedGmailAdapter());
      const draft = await service.draftFollowup(runtime, {
        source: "gmail",
        to: [{ identifier: "self@example.invalid" }],
        subject: "QA",
        body: "Send tomorrow",
        requester,
      });
      const sendAtMs = Date.now() + 86_400_000;
      // A repeat attempt must hit the same refusal (not "already scheduled"),
      // proving no schedule was persisted on the draft.
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          service.scheduleDraftSend(runtime, draft.draftId, sendAtMs),
        ).rejects.toMatchObject({ code: "MESSAGE_SCHEDULE_UNSUPPORTED" });
      }
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
  it("can initialize a second runtime without duplicating or disabling the managed source", async () => {
    const runtime = { agentId: "owned-agent" } as IAgentRuntime;
    if (!inboxPlugin.init) throw new Error("Missing inbox initialization");
    await inboxPlugin.init({}, runtime);
    const first = getDefaultTriageService().getAdapter("gmail");
    expect(first).toBeInstanceOf(ManagedGmailAdapter);
    if (!inboxPlugin.init) throw new Error("Missing inbox initialization");
    await inboxPlugin.init({}, runtime);
    const second = getDefaultTriageService().getAdapter("gmail");
    expect(second).toBeInstanceOf(ManagedGmailAdapter);
    expect(
      getDefaultTriageService()
        .listAdapters()
        .filter((adapter) => adapter.source === "gmail"),
    ).toHaveLength(1);
  });
  it("refuses a source call without an executing owner action before network access", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const adapter = new ManagedGmailAdapter();
    await expect(
      adapter.listMessages({ agentId: "owned-agent" } as IAgentRuntime, {}),
    ).rejects.toThrow("current owner request");
    expect(network).not.toHaveBeenCalled();
  });
  it("refuses a message from another agent before any provider read", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const adapter = new ManagedGmailAdapter();
    const runtime = { agentId: "owned-agent" } as IAgentRuntime;
    await expect(
      adapter.listMessages(runtime, {
        requester: { agentId: "another-agent" } as Memory,
      }),
    ).rejects.toThrow("restricted to its owner");
    expect(network).not.toHaveBeenCalled();
  });
});
