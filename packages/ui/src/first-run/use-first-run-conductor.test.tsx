// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import type { SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api";
import {
  FIRST_RUN_ACTION_PREFIX,
  setFirstRunActionHandler,
  tryHandleFirstRunAction,
} from "./first-run-action-channel";
import { FirstRunConductorMount } from "./use-first-run-conductor";

const mocks = vi.hoisted(() => {
  let conversationMessages: ConversationMessage[] = [];
  return {
    bindCloudAgent: vi.fn(),
    client: {
      listLocalAgentBackups: vi.fn(),
    },
    get conversationMessages() {
      return conversationMessages;
    },
    set conversationMessages(next: ConversationMessage[]) {
      conversationMessages = next;
    },
    getCloudAuthToken: vi.fn(),
    listOrAutoProvisionCloudAgent: vi.fn(),
    preOpenWindow: vi.fn(),
    resetFirstRunPersistGuard: vi.fn(),
    runFirstRunFinish: vi.fn(),
    setConversationMessages: vi.fn(
      (next: SetStateAction<ConversationMessage[]>) => {
        conversationMessages =
          typeof next === "function" ? next(conversationMessages) : next;
      },
    ),
    startTutorial: vi.fn(),
    useAppSelectorShallow: vi.fn(),
  };
});

vi.mock("../api", () => ({
  client: mocks.client,
}));

vi.mock("../api/client-cloud", () => ({
  getCloudAuthToken: mocks.getCloudAuthToken,
}));

vi.mock("../components/pages/tutorial/tutorial-controller", () => ({
  startTutorial: mocks.startTutorial,
}));

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => ({ cloudApiBase: "https://www.elizacloud.ai" }),
}));

vi.mock("../state", () => ({
  useAppSelectorShallow: mocks.useAppSelectorShallow,
}));

vi.mock("../state/ConversationMessagesContext.hooks", () => ({
  useConversationMessages: () => ({
    conversationMessages: mocks.conversationMessages,
    removeConversationMessage: vi.fn(),
    setConversationMessages: mocks.setConversationMessages,
  }),
}));

vi.mock("../utils", () => ({
  preOpenWindow: mocks.preOpenWindow,
}));

vi.mock("./first-run-finish", () => ({
  bindCloudAgent: mocks.bindCloudAgent,
  listOrAutoProvisionCloudAgent: mocks.listOrAutoProvisionCloudAgent,
  resetFirstRunPersistGuard: mocks.resetFirstRunPersistGuard,
  runFirstRunFinish: mocks.runFirstRunFinish,
}));

describe("useFirstRunConductor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationMessages = [];
    mocks.client.listLocalAgentBackups.mockResolvedValue([]);
    mocks.runFirstRunFinish.mockResolvedValue({ kind: "needs-cloud-login" });
    const firstRunState = {
      completeFirstRun: vi.fn(),
      elizaCloudConnected: false,
      firstRunComplete: false,
      firstRunName: "Eliza",
      handleCloudLogin: vi.fn(),
      setState: vi.fn(),
      setTab: vi.fn(),
      showActionBanner: vi.fn(),
      switchAgentProfile: vi.fn(),
      uiLanguage: "en",
    };
    mocks.useAppSelectorShallow.mockImplementation(
      (selector: (state: typeof firstRunState) => unknown) =>
        selector(firstRunState),
    );
  });

  afterEach(() => {
    setFirstRunActionHandler(null);
  });

  it("upserts the cloud-login recovery turn for local + Eliza Cloud inference (#10836)", async () => {
    render(<FirstRunConductorMount />);

    await waitFor(() =>
      expect(mocks.client.listLocalAgentBackups).toHaveBeenCalled(),
    );

    expect(
      tryHandleFirstRunAction(`${FIRST_RUN_ACTION_PREFIX}runtime:local`),
    ).toBe(true);
    await waitFor(() =>
      expect(
        mocks.conversationMessages.some((m) => m.id === "first-run:provider"),
      ).toBe(true),
    );

    expect(
      tryHandleFirstRunAction(`${FIRST_RUN_ACTION_PREFIX}provider:elizacloud`),
    ).toBe(true);

    await waitFor(() => expect(mocks.runFirstRunFinish).toHaveBeenCalled());
    await waitFor(() => {
      const oauthTurn = mocks.conversationMessages.find(
        (m) => m.id === "first-run:cloud-oauth",
      );
      expect(oauthTurn).toMatchObject({
        role: "assistant",
        secretRequest: {
          key: "elizacloud",
          status: "failed",
        },
      });
      expect(oauthTurn?.text).toContain("Connect your Eliza Cloud account");
    });
  });
});
