// @vitest-environment jsdom

/**
 * Exercises the Play-safe Cloud shell through its rendered auth, compose,
 * conversation, and persistence boundaries in a deterministic DOM harness.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANDROID_CLOUD_COMPOSE_EVENT,
  ANDROID_CLOUD_CONVERSATION_ID_KEY,
  type AndroidCloudAccountLifecycleAdapter,
  AndroidCloudApp,
  type AndroidCloudVoiceAdapter,
} from "./AndroidCloudApp";
import type { AccountDeletionRequestDto } from "./account-deletion-contract";
import { AndroidCloudClient } from "./android-cloud-client";

const session = {
  identity: {
    id: "20000000-0000-4000-8000-000000000002",
    displayName: "Ada",
  },
  token: "steward-token",
  chatApiBase: "https://30000000-0000-4000-8000-000000000003.cloud.eliza.app",
};

function createClient(): AndroidCloudClient {
  return new AndroidCloudClient({
    fetchImpl: vi.fn<typeof fetch>(),
  });
}

function createVoice(): AndroidCloudVoiceAdapter {
  return {
    requestAndStart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    speak: vi.fn(async () => undefined),
  };
}

function deletionRequest(): AccountDeletionRequestDto {
  return {
    requestId: "receipt_android_opaque_1",
    status: "recovery" as const,
    requestedAt: "2026-08-22T00:00:00.000Z",
    recoveryExpiresAt: "2026-09-21T00:00:00.000Z",
    scheduledDeletionAt: "2026-09-21T00:00:00.000Z",
    irreversibleAt: null,
    completedAt: null,
    identityDeactivated: true,
    accessState: "fenced",
    canCancel: true,
    nextAction: "download_export_or_cancel",
    export: {
      status: "building" as const,
      readyAt: null,
      expiresAt: "2026-09-21T00:00:00.000Z",
      contentDigest: null,
    },
  };
}

function createLifecycle(
  status = null as ReturnType<typeof deletionRequest> | null,
): AndroidCloudAccountLifecycleAdapter {
  return {
    getStatus: vi.fn(async () => status),
    requestDeletion: vi.fn(async () => deletionRequest()),
    cancelDeletion: vi.fn(
      async (): Promise<AccountDeletionRequestDto> => ({
        ...deletionRequest(),
        status: "canceled",
        identityDeactivated: false,
        accessState: "active",
        canCancel: false,
        nextAction: "none",
      }),
    ),
    downloadExport: vi.fn(async () => true),
  };
}

describe("AndroidCloudApp", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => cleanup());

  it("ends dictation and surfaces an asynchronous native voice failure", async () => {
    const client = createClient();
    const voice = createVoice();
    let publishError: ((error: Error) => void) | undefined;
    vi.mocked(voice.requestAndStart).mockImplementation(
      async (_onTranscript, onError) => {
        publishError = onError;
      },
    );
    vi.spyOn(client, "restoreSession").mockResolvedValue(session);
    render(<AndroidCloudApp client={client} voice={voice} />);
    await screen.findByText("Ada");

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop dictation" }),
      ).toBeTruthy(),
    );
    act(() =>
      publishError?.(new Error("No speech was recognized. Try again.")),
    );

    expect(
      screen.getByRole("button", { name: "Start dictation" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "No speech was recognized. Try again.",
    );
  });

  it("renders a retryable signed-out state when no stored session exists", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    render(<AndroidCloudApp client={client} voice={createVoice()} />);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(
      screen.getByText("Sign in securely to chat with your Eliza."),
    ).toBeTruthy();
  });

  it("does not open the browser when sign-in is canceled while session creation is pending", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    let resolveLogin!: (value: {
      sessionId: string;
      browserUrl: string;
    }) => void;
    let loginSignal: AbortSignal | undefined;
    vi.spyOn(client, "beginLogin").mockImplementation(
      (signal) =>
        new Promise((resolve) => {
          loginSignal = signal;
          resolveLogin = resolve;
        }),
    );
    const openExternal = vi.fn();
    render(
      <AndroidCloudApp
        client={client}
        openExternal={openExternal}
        voice={createVoice()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel sign-in" }),
    );
    expect(loginSignal?.aborted).toBe(true);

    await act(async () => {
      resolveLogin({
        sessionId: "10000000-0000-4000-8000-000000000001",
        browserUrl:
          "https://cloud.eliza.app/auth/cli-login?session=10000000-0000-4000-8000-000000000001",
      });
      await Promise.resolve();
    });

    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not persist a poll result that resolves after sign-in cancellation", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl:
        "https://cloud.eliza.app/auth/cli-login?session=10000000-0000-4000-8000-000000000001",
    });
    let resolvePoll!: (value: {
      status: "authenticated";
      token: string;
    }) => void;
    const poll = new Promise<{
      status: "authenticated";
      token: string;
    }>((resolve) => {
      resolvePoll = resolve;
    });
    vi.spyOn(client, "pollLogin").mockReturnValue(poll);
    const persistLogin = vi.spyOn(client, "persistLogin");
    const originalSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(
      (handler, timeout, ...args): ReturnType<typeof setTimeout> =>
        originalSetTimeout(
          handler,
          timeout === 1_500 ? 0 : timeout,
          ...args,
        ) as unknown as ReturnType<typeof setTimeout>,
    );
    render(
      <AndroidCloudApp
        client={client}
        openExternal={vi.fn(async () => undefined)}
        closeExternal={vi.fn(async () => undefined)}
        voice={createVoice()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(client.pollLogin).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await act(async () => {
      resolvePoll({ status: "authenticated", token: "stale-token" });
      await poll;
      await Promise.resolve();
    });

    expect(persistLogin).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("discards only the persisted token when sign-in is canceled while closing the browser", async () => {
    const client = createClient();
    const restoreSession = vi
      .spyOn(client, "restoreSession")
      .mockResolvedValue(null);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl:
        "https://cloud.eliza.app/auth/cli-login?session=10000000-0000-4000-8000-000000000001",
    });
    vi.spyOn(client, "pollLogin").mockResolvedValue({
      status: "authenticated",
      token: "persisted-token-a",
    });
    const persistLogin = vi
      .spyOn(client, "persistLogin")
      .mockResolvedValue(undefined);
    const discardLogin = vi
      .spyOn(client, "discardLogin")
      .mockResolvedValue(undefined);
    let resolveClose!: () => void;
    const deferredClose = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const closeExternal = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(deferredClose)
      .mockResolvedValue(undefined);
    const originalSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(
      (handler, timeout, ...args): ReturnType<typeof setTimeout> =>
        originalSetTimeout(
          handler,
          timeout === 1_500 ? 0 : timeout,
          ...args,
        ) as unknown as ReturnType<typeof setTimeout>,
    );
    render(
      <AndroidCloudApp
        client={client}
        openExternal={vi.fn(async () => undefined)}
        closeExternal={closeExternal}
        voice={createVoice()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(persistLogin).toHaveBeenCalledWith(
        "persisted-token-a",
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(closeExternal).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    resolveClose();

    await waitFor(() =>
      expect(discardLogin).toHaveBeenCalledWith("persisted-token-a"),
    );
    expect(discardLogin).toHaveBeenCalledOnce();
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("Ada")).toBeNull();
  });

  it("accepts a native share/deep-link compose event without auto-sending", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(session);
    vi.spyOn(client, "createConversation");
    render(<AndroidCloudApp client={client} voice={createVoice()} />);
    await screen.findByText("Ada");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(ANDROID_CLOUD_COMPOSE_EVENT, {
          detail: { text: "Shared safely" },
        }),
      );
    });

    await waitFor(() =>
      expect(
        (screen.getByLabelText("Message Eliza") as HTMLTextAreaElement).value,
      ).toBe("Shared safely"),
    );
    expect(client.createConversation).not.toHaveBeenCalled();
  });

  it("moves New chat and Settings into the swipe launcher", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(session);
    render(
      <AndroidCloudApp
        accountLifecycle={createLifecycle()}
        client={client}
        voice={createVoice()}
      />,
    );
    await screen.findByText("Ada");

    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    fireEvent.touchStart(screen.getByRole("main"), {
      changedTouches: [{ clientX: 320 }],
    });
    fireEvent.touchEnd(screen.getByRole("main"), {
      changedTouches: [{ clientX: 120 }],
    });

    expect(
      screen.getByRole("navigation", { name: "Eliza launcher" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete account & data" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText("Checking deletion status…")).toBeNull(),
    );
  });

  it("restores a scoped deletion status after the ordinary session is gone", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    const lifecycle = createLifecycle(deletionRequest());
    render(
      <AndroidCloudApp
        accountLifecycle={lifecycle}
        client={client}
        voice={createVoice()}
      />,
    );

    expect(await screen.findByText("Deletion requested")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(lifecycle.getStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText("receipt_android_opaque_1")).toBeTruthy();
  });

  it("creates one server conversation and renders a successful text reply", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(session);
    vi.spyOn(client, "createConversation").mockResolvedValue("conversation-1");
    vi.spyOn(client, "sendChat").mockImplementation(
      async (_session, _conversationId, _text, onText) => {
        onText("Hello from Eliza");
        return "Hello from Eliza";
      },
    );
    render(<AndroidCloudApp client={client} voice={createVoice()} />);
    await screen.findByText("Ada");

    fireEvent.change(screen.getByLabelText("Message Eliza"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Hello from Eliza")).toBeTruthy();
    expect(client.createConversation).toHaveBeenCalledWith(session);
    expect(client.sendChat).toHaveBeenCalledWith(
      session,
      "conversation-1",
      "Hello",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(localStorage.getItem(ANDROID_CLOUD_CONVERSATION_ID_KEY)).toBe(
      "conversation-1",
    );
    expect(JSON.stringify(localStorage)).not.toContain("Hello from Eliza");
  });

  it("removes the pending assistant row when a send is stopped", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(session);
    vi.spyOn(client, "createConversation").mockResolvedValue("conversation-1");
    vi.spyOn(client, "sendChat").mockImplementation(
      async (_session, _conversationId, _text, _onText, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    render(<AndroidCloudApp client={client} voice={createVoice()} />);
    await screen.findByText("Ada");

    fireEvent.change(screen.getByLabelText("Message Eliza"), {
      target: { value: "Never finish" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Thinking…")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(screen.queryByText("Thinking…")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Never finish")).toBeTruthy();
  });
});
