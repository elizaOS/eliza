/**
 * Draft-start lifecycle coverage proves queued composer text and attachments
 * survive the reset boundary through the real lifecycle hook.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentStatus,
  type Conversation,
  client,
  type FirstRunOptions,
  type ImageAttachment,
} from "../api";
import type { AppState, LifecycleAction } from "./internal";
import {
  type UseChatLifecycleDeps,
  useChatLifecycle,
} from "./useChatLifecycle";

function makeDeps(
  restoredDraft: {
    text: string;
    images: ImageAttachment[];
  },
  state: {
    text: string;
    images: ImageAttachment[];
    calls: string[];
  },
): UseChatLifecycleDeps {
  const lifecycleBusyRef: MutableRefObject<boolean> = { current: false };
  const lifecycleActionRef: MutableRefObject<LifecycleAction | null> = {
    current: null,
  };
  const activeConversationIdRef: MutableRefObject<string | null> = {
    current: "conv-1",
  };
  const elizaCloudPreferDisconnectedUntilLoginRef: MutableRefObject<boolean> = {
    current: false,
  };
  const firstRunCompletionCommittedRef: MutableRefObject<boolean> = {
    current: false,
  };
  const coordinatorResetRef: MutableRefObject<(() => void) | null> = {
    current: null,
  };

  return {
    agentStatus: null,
    setAgentStatus: vi.fn(),
    pollAgentReadiness: false,
    lifecycleAction: null,
    beginLifecycleAction: vi.fn(() => true),
    finishLifecycleAction: vi.fn(),
    lifecycleBusyRef,
    lifecycleActionRef,
    setActionNotice: vi.fn(),
    pendingRestart: false,
    pendingRestartReasons: [],
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
    resetBackendConnection: vi.fn(),
    loadConversations: vi.fn(async (): Promise<Conversation[] | null> => []),
    loadPlugins: vi.fn(async (): Promise<unknown> => null),
    hydrateInitialConversationState: vi.fn(
      async (): Promise<string | null> => null,
    ),
    requestGreetingWhenRunning: vi.fn(async (): Promise<void> => {}),
    interruptActiveChatPipelineWithDraft: vi.fn(() => {
      state.calls.push("interrupt");
      return restoredDraft;
    }),
    resetConversationDraftState: vi.fn(() => {
      state.calls.push("reset");
      state.text = "";
      state.images = [];
    }),
    setChatInput: vi.fn((text: string) => {
      state.calls.push("text");
      state.text = text;
    }),
    setChatPendingImages: vi.fn((images: ImageAttachment[]) => {
      state.calls.push("images");
      state.images = images;
    }),
    setActiveConversationId: vi.fn(),
    setConversationMessages: vi.fn(),
    setConversations: vi.fn(),
    activeConversationIdRef,
    elizaCloudPreferDisconnectedUntilLoginRef,
    setElizaCloudEnabled: vi.fn(),
    setElizaCloudConnected: vi.fn(),
    setElizaCloudVoiceProxyAvailable: vi.fn(),
    setElizaCloudHasPersistedKey: vi.fn(),
    setElizaCloudCredits: vi.fn(),
    setElizaCloudCreditsLow: vi.fn(),
    setElizaCloudCreditsCritical: vi.fn(),
    setElizaCloudAuthRejected: vi.fn(),
    setElizaCloudCreditsError: vi.fn(),
    setElizaCloudTopUpUrl: vi.fn(),
    setElizaCloudUserId: vi.fn(),
    setElizaCloudStatusReason: vi.fn(),
    setElizaCloudLoginError: vi.fn(),
    firstRunCompletionCommittedRef,
    setFirstRunUiRevealNonce: vi.fn(),
    setFirstRunLoading: vi.fn(),
    setFirstRunComplete: vi.fn(),
    setFirstRunDeferredTasks: vi.fn(),
    setPostFirstRunChecklistDismissed: vi.fn(),
    setFirstRunName: vi.fn(),
    setFirstRunStyle: vi.fn(),
    setFirstRunRuntimeTarget: vi.fn(
      (_target: AppState["firstRunRuntimeTarget"]) => {},
    ),
    setFirstRunProvider: vi.fn(),
    setFirstRunRemoteConnected: vi.fn(),
    setFirstRunRemoteApiBase: vi.fn(),
    setFirstRunRemoteToken: vi.fn(),
    setFirstRunOptions: vi.fn((_options: FirstRunOptions | null) => {}),
    setSelectedVrmIndex: vi.fn(),
    setCustomVrmUrl: vi.fn(),
    setCustomBackgroundUrl: vi.fn(),
    setPlugins: vi.fn(),
    setSkills: vi.fn(),
    setLogs: vi.fn(),
    coordinatorResetRef,
  };
}

describe("useChatLifecycle draft restoration", () => {
  it("interrupts before reset and then reapplies both queued text and images", async () => {
    const image: ImageAttachment = {
      data: "AAAA",
      mimeType: "image/png",
      name: "queued.png",
    };
    const state = {
      text: "old draft",
      images: [] as ImageAttachment[],
      calls: [] as string[],
    };
    const deps = makeDeps({ text: "queued message", images: [image] }, state);
    const { result } = renderHook(() => useChatLifecycle(deps));

    await act(async () => {
      await result.current.handleStartDraftConversation();
    });

    expect(state.calls).toEqual(["interrupt", "reset", "text", "images"]);
    expect(state.text).toBe("queued message");
    expect(state.images).toEqual([image]);
  });

  it("releases the restart lifecycle lock before optional hydration settles", async () => {
    const state = {
      text: "",
      images: [] as ImageAttachment[],
      calls: [] as string[],
    };
    const deps = makeDeps({ text: "", images: [] }, state);
    const runningStatus: AgentStatus = {
      state: "running",
      agentName: "Eliza",
      model: undefined,
      uptime: undefined,
      startedAt: undefined,
      port: 32437,
      canRespond: true,
    };
    vi.spyOn(client, "restartAndWait").mockResolvedValueOnce(runningStatus);
    deps.hydrateInitialConversationState = vi.fn(
      () => new Promise<string | null>(() => {}),
    );

    const { result } = renderHook(() => useChatLifecycle(deps));

    await act(async () => {
      await result.current.handleRestart();
    });

    expect(deps.setAgentStatus).toHaveBeenLastCalledWith(runningStatus);
    expect(deps.finishLifecycleAction).toHaveBeenCalledTimes(1);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      "Agent restarted.",
      "success",
      2400,
    );
  });
});
