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
    const signOut = vi.spyOn(client, "signOut").mockResolvedValue(undefined);
    const openExternal = vi.fn(async () => undefined);
    const closeExternal = vi.fn(async () => undefined);
    const originalSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(
      (handler, timeout, ...args) => {
        if (timeout === 1_500) {
          queueMicrotask(() => {
            if (typeof handler === "function") handler(...args);
          });
          return 1;
        }
        return originalSetTimeout(handler, timeout, ...args);
      },
    );
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

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(client.restoreSession).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
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
});
