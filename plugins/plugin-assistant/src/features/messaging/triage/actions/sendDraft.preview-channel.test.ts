/**
 * A channel-delivered draft (discord) is posted to `channelId` whoever `to`
 * names. The preview the owner confirms must name that channel, or a message
 * addressed to a person is approved for a public channel unseen.
 */
import type {
  Content,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createFakeRuntime } from "../__tests__/fake-runtime.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
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

class ChannelAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "discord";
  isAvailable(): boolean {
    return true;
  }
  capabilities(): MessageAdapterCapabilities {
    return {
      list: false,
      search: false,
      manage: {},
      send: { reply: true, new: true, schedule: false },
      worlds: "multi",
      channels: "explicit",
    };
  }
  protected createDraftImpl(
    _runtime: IAgentRuntime,
    draft: DraftRequest,
  ): Promise<{ draftId: string; preview: string }> {
    return Promise.resolve({
      draftId: `discord-draft:${draft.channelId}:1`,
      preview: draft.body,
    });
  }
}

beforeEach(() => {
  __resetDefaultMessageRefStoreForTests();
  __resetDefaultTriageServiceForTests();
});
afterEach(() => {
  __resetDefaultTriageServiceForTests();
  __resetDefaultMessageRefStoreForTests();
});

it("names the destination channel in the preview the owner confirms", async () => {
  getDefaultTriageService().register(new ChannelAdapter());
  const delivered: Content[] = [];
  const cache = new Map<string, unknown>();
  const runtime = Object.assign(createFakeRuntime(), {
    getCache: async <T>(key: string) => (cache.get(key) as T) ?? undefined,
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
      const current = cache.get(key);
      if (JSON.stringify(current ?? null) !== JSON.stringify(expected ?? null))
        return false;
      cache.set(key, value);
      return true;
    },
  }) as IAgentRuntime;
  const result = await sendDraftAction.handler(
    runtime,
    {
      id: "00000000-0000-4000-8000-000000000101",
      entityId: "00000000-0000-4000-8000-000000000102",
      roomId: "00000000-0000-4000-8000-000000000103",
      createdAt: 1_000,
      content: { text: "DM Bob: the meeting moved to 3pm" },
    } as Memory,
    {
      values: { __contextRouting: { primaryContext: "messaging" } },
      data: {},
      text: "",
    } as State,
    {
      parameters: {
        source: "discord",
        to: ["Bob"],
        body: "the meeting moved to 3pm",
        channelId: "555",
      },
    } as HandlerOptions,
    async (content) => {
      delivered.push(content);
      return [];
    },
  );
  const text = (result as { text?: string }).text ?? "";
  expect({
    previewNamesChannel: text.includes("To: Bob in channel 555"),
    callbackNamesChannel: delivered.some((content) =>
      (content.text ?? "").includes("in channel 555"),
    ),
  }).toEqual({ previewNamesChannel: true, callbackNamesChannel: true });
});
