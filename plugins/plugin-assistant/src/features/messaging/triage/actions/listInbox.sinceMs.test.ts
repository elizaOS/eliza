/**
 * Cached-path time filtering for the MESSAGE listInbox action. The action
 * serves the TriageService store when it is non-empty; that path must honor
 * the documented `sinceMs` floor exactly like the live `triage()` pull does,
 * otherwise one identical request returns time-filtered rows when the cache
 * is cold and unfiltered rows when it is warm. Real in-process TriageService
 * with a deterministic connector adapter; no live connector, model, or
 * database.
 */
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeRuntime } from "../__tests__/fake-runtime.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
} from "../triage-service.ts";
import type { ListOptions, MessageRef, MessageSource } from "../types.ts";
import { listInboxAction } from "./listInbox.ts";

function messageRef(overrides: Partial<MessageRef> = {}): MessageRef {
  return {
    id: "message-1",
    source: "gmail",
    externalId: "external-message-1",
    from: { identifier: "sender@example.com" },
    to: [{ identifier: "owner@example.com" }],
    snippet: "Message preview",
    receivedAtMs: 1_000,
    hasAttachments: false,
    isRead: false,
    ...overrides,
  };
}

function options(parameters: Record<string, unknown>): HandlerOptions {
  return { parameters } as HandlerOptions;
}

async function runListInbox(parameters: Record<string, unknown> = {}) {
  return listInboxAction.handler(
    createFakeRuntime(),
    { content: { text: "Show me unread" } } as Memory,
    undefined,
    options(parameters),
  );
}

function resultMessages(result: Awaited<ReturnType<typeof runListInbox>>) {
  if (!result?.success) throw new Error(`action failed: ${result?.error}`);
  const data = result.data as {
    total: number;
    returned: number;
    messages: Array<{ id: string }>;
  };
  return data;
}

describe("listInboxAction cached sinceMs floor", () => {
  beforeEach(() => {
    __resetDefaultMessageRefStoreForTests();
    __resetDefaultTriageServiceForTests();
  });

  it("excludes cached unread rows older than sinceMs", async () => {
    const service = getDefaultTriageService();
    service.getStore().saveMessages([
      messageRef({
        id: "old-unread",
        externalId: "external-old",
        receivedAtMs: 1_000,
        snippet: "old message",
      }),
      messageRef({
        id: "new-unread",
        externalId: "external-new",
        receivedAtMs: 2_000,
        snippet: "new message",
      }),
    ]);

    const data = resultMessages(await runListInbox({ sinceMs: 1_500 }));

    expect(data.total).toBe(1);
    expect(data.messages.map((m) => m.id)).toEqual(["new-unread"]);
  });

  it("keeps every cached unread row when sinceMs is absent", async () => {
    const service = getDefaultTriageService();
    service.getStore().saveMessages([
      messageRef({ id: "old-unread", externalId: "external-old" }),
      messageRef({
        id: "new-unread",
        externalId: "external-new",
        receivedAtMs: 2_000,
      }),
    ]);

    const data = resultMessages(await runListInbox());

    expect(data.total).toBe(2);
    expect(data.messages.map((m) => m.id).sort()).toEqual([
      "new-unread",
      "old-unread",
    ]);
  });

  it("matches the cold live pull that filters at the adapter boundary", async () => {
    // Real adapters own the live-path floor: triage() forwards sinceMs into
    // listMessages and each adapter enforces it, so this deterministic
    // adapter filters exactly like the shipped connector adapters do.
    class ColdAdapter extends BaseMessageAdapter {
      readonly source: MessageSource = "gmail";
      readonly seenSince: Array<number | undefined> = [];

      constructor(private readonly messages: MessageRef[]) {
        super();
      }

      isAvailable(): boolean {
        return true;
      }

      protected override async listMessagesImpl(
        _runtime: IAgentRuntime,
        opts: ListOptions,
      ): Promise<MessageRef[]> {
        this.seenSince.push(opts.sinceMs);
        return this.messages.filter(
          (m) => opts.sinceMs === undefined || m.receivedAtMs >= opts.sinceMs,
        );
      }
    }

    const adapter = new ColdAdapter([
      messageRef({
        id: "old-unread",
        externalId: "external-old",
        receivedAtMs: 1_000,
      }),
      messageRef({
        id: "new-unread",
        externalId: "external-new",
        receivedAtMs: 2_000,
      }),
    ]);
    const service = getDefaultTriageService();
    service.register(adapter);

    const data = resultMessages(await runListInbox({ sinceMs: 1_500 }));

    expect(adapter.seenSince).toEqual([1_500]);
    expect(data.total).toBe(1);
    expect(data.messages.map((m) => m.id)).toEqual(["new-unread"]);
  });
});
