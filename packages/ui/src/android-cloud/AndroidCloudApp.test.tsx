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

  it("aborts an in-flight login poll without restoring a stale session", async () => {
    const client = createClient();
    const restoreSession = vi
      .spyOn(client, "restoreSession")
      .mockResolvedValue(null);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl:
        "https://cloud.eliza.app/auth/cli-login?session=10000000-0000-4000-8000-000000000001",
    });
    let resolvePoll:
      | ((result: { status: "authenticated"; token: string }) => void)
      | undefined;
    const pollLogin = vi.spyOn(client, "pollLogin").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePoll = resolve;
        }),
    );
    const closeExternal = vi.fn(async () => undefined);

    render(
      <AndroidCloudApp
        client={client}
        openExternal={vi.fn(async () => undefined)}
        closeExternal={closeExternal}
        voice={createVoice()}
      />,
    );
    const signInButton = await screen.findByRole("button", { name: "Sign in" });
    vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
    ) => {
      if (typeof handler === "function") handler();
      return 1;
    }) as typeof window.setTimeout);
    fireEvent.click(signInButton);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pollLogin).toHaveBeenCalledOnce();
    const signal = pollLogin.mock.calls[0]?.[1];

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(signal?.aborted).toBe(true);
    resolvePoll?.({ status: "authenticated", token: "stale-token" });
    await act(async () => undefined);

    expect(restoreSession).toHaveBeenCalledOnce();
    expect(closeExternal).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
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

  it("stops listening and displays an asynchronous native voice error", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(session);
    let reportVoiceError: ((error: Error) => void) | undefined;
    const voice: AndroidCloudVoiceAdapter = {
      requestAndStart: vi.fn(async (_onTranscript, onError) => {
        reportVoiceError = onError;
      }),
      stop: vi.fn(async () => undefined),
      speak: vi.fn(async () => undefined),
    };
    render(<AndroidCloudApp client={client} voice={voice} />);
    await screen.findByText("Ada");

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    expect(
      await screen.findByRole("button", { name: "Stop dictation" }),
    ).toBeTruthy();
    act(() => reportVoiceError?.(new Error("Voice network unavailable.")));

    expect(
      screen.getByRole("button", { name: "Start dictation" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Voice network unavailable.",
    );
  });
});
