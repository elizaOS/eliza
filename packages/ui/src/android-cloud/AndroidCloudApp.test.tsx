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
  AndroidCloudApp,
  type AndroidCloudVoiceAdapter,
} from "./AndroidCloudApp";
import {
  AndroidCloudClient,
  type AndroidCloudSession,
} from "./android-cloud-client";

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

function accelerateLoginPollTimers(): void {
  const originalSetTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, "setTimeout").mockImplementation(
    (handler, timeout, ...args): ReturnType<typeof setTimeout> =>
      originalSetTimeout(
        handler,
        timeout === 1_500 ? 0 : timeout,
        ...args,
      ) as unknown as ReturnType<typeof setTimeout>,
  );
}

describe("AndroidCloudApp", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => cleanup());

  it("renders a retryable signed-out state when no stored session exists", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    render(<AndroidCloudApp client={client} voice={createVoice()} />);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(
      screen.getByText("Sign in securely to chat with your Eliza."),
    ).toBeTruthy();
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

  it("cancels an in-flight login poll without restoring its session", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl: "https://cloud.eliza.app/auth/cli-login",
    });
    let resolvePoll: (value: {
      status: "authenticated";
      token: string;
    }) => void = () => {};
    const poll = new Promise<{ status: "authenticated"; token: string }>(
      (resolve) => {
        resolvePoll = resolve;
      },
    );
    const pollLogin = vi.spyOn(client, "pollLogin").mockReturnValue(poll);
    const discardLoginAttempt = vi
      .spyOn(client, "discardLoginAttempt")
      .mockResolvedValue(undefined);
    const openExternal = vi.fn(async () => undefined);
    const closeExternal = vi.fn(async () => undefined);
    accelerateLoginPollTimers();
    render(
      <AndroidCloudApp
        client={client}
        openExternal={openExternal}
        closeExternal={closeExternal}
        voice={createVoice()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(pollLogin).toHaveBeenCalledOnce());
    const signal = pollLogin.mock.calls[0]?.[1];

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(signal?.aborted).toBe(true);
    resolvePoll({ status: "authenticated", token: "cancelled-token" });

    await waitFor(() =>
      expect(discardLoginAttempt).toHaveBeenCalledWith(
        "10000000-0000-4000-8000-000000000001",
        "cancelled-token",
      ),
    );
    expect(client.restoreSession).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("cancels while the authenticated session is being restored", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(session);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl: "https://cloud.eliza.app/auth/cli-login",
    });
    vi.spyOn(client, "pollLogin").mockResolvedValue({
      status: "authenticated",
      token: "cancelled-token",
    });
    let finishRestore: (value: AndroidCloudSession | null) => void = () => {};
    client.restoreSession = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(
        new Promise<AndroidCloudSession | null>((resolve) => {
          finishRestore = resolve;
        }),
      );
    const discardLoginAttempt = vi
      .spyOn(client, "discardLoginAttempt")
      .mockResolvedValue(undefined);
    accelerateLoginPollTimers();

    render(
      <AndroidCloudApp
        client={client}
        openExternal={vi.fn(async () => undefined)}
        closeExternal={vi.fn(async () => undefined)}
        voice={createVoice()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(client.restoreSession).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    finishRestore(session);

    await waitFor(() =>
      expect(discardLoginAttempt).toHaveBeenCalledWith(
        "10000000-0000-4000-8000-000000000001",
        "cancelled-token",
      ),
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("Ada")).toBeNull();
  });

  it("discards a cancelled login when its session restore rejects", async () => {
    const client = createClient();
    let rejectRestore: (error: Error) => void = () => {};
    client.restoreSession = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(
        new Promise<AndroidCloudSession | null>((_resolve, reject) => {
          rejectRestore = reject;
        }),
      );
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl: "https://cloud.eliza.app/auth/cli-login",
    });
    vi.spyOn(client, "pollLogin").mockResolvedValue({
      status: "authenticated",
      token: "cancelled-token",
    });
    const discardLoginAttempt = vi
      .spyOn(client, "discardLoginAttempt")
      .mockResolvedValue(undefined);
    accelerateLoginPollTimers();

    render(
      <AndroidCloudApp
        client={client}
        openExternal={vi.fn(async () => undefined)}
        closeExternal={vi.fn(async () => undefined)}
        voice={createVoice()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(client.restoreSession).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    rejectRestore(new Error("session verification failed"));

    await waitFor(() =>
      expect(discardLoginAttempt).toHaveBeenCalledWith(
        "10000000-0000-4000-8000-000000000001",
        "cancelled-token",
      ),
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let stale attempt cleanup replace a newer successful login", async () => {
    const client = createClient();
    const newerSession: AndroidCloudSession = {
      ...session,
      identity: { ...session.identity, displayName: "Bea" },
      token: "newer-token",
    };
    let finishStaleRestore: (value: AndroidCloudSession | null) => void =
      () => {};
    client.restoreSession = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(
        new Promise<AndroidCloudSession | null>((resolve) => {
          finishStaleRestore = resolve;
        }),
      )
      .mockResolvedValueOnce(newerSession);
    vi.spyOn(client, "beginLogin")
      .mockResolvedValueOnce({
        sessionId: "10000000-0000-4000-8000-000000000001",
        browserUrl: "https://cloud.eliza.app/auth/cli-login",
      })
      .mockResolvedValueOnce({
        sessionId: "10000000-0000-4000-8000-000000000002",
        browserUrl: "https://cloud.eliza.app/auth/cli-login",
      });
    vi.spyOn(client, "pollLogin")
      .mockResolvedValueOnce({ status: "authenticated", token: "stale-token" })
      .mockResolvedValueOnce({ status: "authenticated", token: "newer-token" });
    const discardLoginAttempt = vi
      .spyOn(client, "discardLoginAttempt")
      .mockResolvedValue(undefined);
    accelerateLoginPollTimers();

    render(
      <AndroidCloudApp
        client={client}
        openExternal={vi.fn(async () => undefined)}
        closeExternal={vi.fn(async () => undefined)}
        voice={createVoice()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(client.restoreSession).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Bea")).toBeTruthy();
    finishStaleRestore(session);

    await waitFor(() =>
      expect(discardLoginAttempt).toHaveBeenCalledWith(
        "10000000-0000-4000-8000-000000000001",
        "stale-token",
      ),
    );
    expect(screen.getByText("Bea")).toBeTruthy();
    expect(screen.queryByText("Ada")).toBeNull();
  });

  it("leaves listening state and surfaces an asynchronous voice error", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(session);
    let reportError: (error: Error) => void = () => {};
    const voice: AndroidCloudVoiceAdapter = {
      requestAndStart: vi.fn(async (_onTranscript, onError) => {
        reportError = onError;
      }),
      stop: vi.fn(async () => undefined),
      speak: vi.fn(async () => undefined),
    };
    render(<AndroidCloudApp client={client} voice={voice} />);
    await screen.findByText("Ada");

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    await screen.findByRole("button", { name: "Stop dictation" });
    act(() => reportError(new Error("Voice recognition failed.")));

    expect(
      await screen.findByRole("button", { name: "Start dictation" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Voice recognition failed.",
    );
  });

  it("does not enter listening state when voice fails during startup", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(session);
    const voice: AndroidCloudVoiceAdapter = {
      requestAndStart: vi.fn(async (_onTranscript, onError) => {
        onError(new Error("Immediate voice failure."));
      }),
      stop: vi.fn(async () => undefined),
      speak: vi.fn(async () => undefined),
    };
    render(<AndroidCloudApp client={client} voice={voice} />);
    await screen.findByText("Ada");

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));

    expect(
      await screen.findByRole("button", { name: "Start dictation" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Immediate voice failure.",
    );
  });
});
