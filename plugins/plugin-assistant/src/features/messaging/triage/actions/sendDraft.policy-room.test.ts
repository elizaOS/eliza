/**
 * A send held for owner approval must be enqueued for the room and requester
 * of the confirming turn. The owner-send policy creates its approval task
 * from `draft.metadata.roomId`/`entityId` and falls back to the agent's own
 * room, where no confirmation can reach it.
 */
import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createFakeRuntime } from "../__tests__/fake-runtime.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
import { registerSendPolicy } from "../send-policy.ts";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
} from "../triage-service.ts";
import type {
  DraftRequest,
  MessageAdapterCapabilities,
  MessageSource,
} from "../types.ts";
import { sendDraftAction } from "./sendDraft.ts";

class GmailLikeAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "gmail";
  isAvailable(): boolean {
    return true;
  }
  capabilities(): MessageAdapterCapabilities {
    return {
      list: false,
      search: false,
      manage: {},
      send: { reply: true, new: true, schedule: false },
      worlds: "single",
      channels: "none",
    };
  }
  protected createDraftImpl(
    _runtime: IAgentRuntime,
    draft: DraftRequest,
  ): Promise<{ draftId: string; preview: string }> {
    return Promise.resolve({ draftId: "gmail-draft-1", preview: draft.body });
  }
}

function runtimeWithCache(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return Object.assign(createFakeRuntime(), {
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    compareAndSetCache: async (
      key: string,
      expected: unknown,
      value: unknown,
    ) => {
      if (
        JSON.stringify(cache.get(key) ?? null) !==
        JSON.stringify(expected ?? null)
      )
        return false;
      cache.set(key, value);
      return true;
    },
  }) as IAgentRuntime;
}

const ROOM = "00000000-0000-4000-8000-000000000203";
const OWNER = "00000000-0000-4000-8000-000000000202";

function turn(text: string, createdAt: number): Memory {
  return {
    id: `00000000-0000-4000-8000-${String(createdAt).padStart(12, "0")}`,
    entityId: OWNER,
    roomId: ROOM,
    createdAt,
    content: { text },
  } as Memory;
}

const state = {
  values: { __contextRouting: { primaryContext: "messaging" } },
  data: {},
  text: "",
} as State;

beforeEach(() => {
  __resetDefaultMessageRefStoreForTests();
  __resetDefaultTriageServiceForTests();
});
afterEach(() => {
  __resetDefaultTriageServiceForTests();
  __resetDefaultMessageRefStoreForTests();
});

it("enqueues the owner-approval hold for the confirming turn's room and requester", async () => {
  getDefaultTriageService().register(new GmailLikeAdapter());
  const runtime = runtimeWithCache();
  const held: DraftRequest[] = [];
  registerSendPolicy(runtime, {
    async shouldRequireApproval() {
      return true;
    },
    async enqueueApproval(_runtime, draft) {
      held.push(draft);
      return { requestId: "approval-1", preview: draft.body };
    },
  });
  const parameters = {
    source: "gmail",
    to: ["alice@example.com"],
    subject: "Notes",
    body: "The notes.",
  };
  const preview = await sendDraftAction.handler(
    runtime,
    turn("email alice the notes", 1_000),
    state,
    { parameters } as HandlerOptions,
  );
  const draftId = (preview as { data?: { draftId?: string } }).data?.draftId;
  const confirmed = await sendDraftAction.handler(
    runtime,
    turn("yes", 2_000),
    state,
    { parameters: { draftId } } as HandlerOptions,
  );
  expect({
    pending: (preview as { data?: { requiresConfirmation?: boolean } }).data
      ?.requiresConfirmation,
    heldText: /owner's approval/.test(
      (confirmed as { text?: string }).text ?? "",
    ),
    heldFor: held.map((draft) => ({
      roomId: draft.metadata?.roomId,
      entityId: draft.metadata?.entityId,
    })),
  }).toEqual({
    pending: true,
    heldText: true,
    heldFor: [{ roomId: ROOM, entityId: OWNER }],
  });
});
