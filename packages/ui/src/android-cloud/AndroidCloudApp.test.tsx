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
  type AndroidCloudGoogleIdentityAdapter,
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

function createGoogleIdentity(): AndroidCloudGoogleIdentityAdapter {
  return {
    signIn: vi.fn(async () => ({ idToken: "google-id-token" })),
    cancel: vi.fn(async () => undefined),
    clearCredentialState: vi.fn(async () => undefined),
  };
}

describe("AndroidCloudApp", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => cleanup());

  it("uses native Google while keeping canonical Steward options available", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(session);
    const nativeSignIn = vi
      .spyOn(client, "signInWithGoogle")
      .mockResolvedValue(undefined);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl:
        "https://cloud.eliza.app/auth/cli-login?session=10000000-0000-4000-8000-000000000001",
    });
    vi.spyOn(client, "pollLogin").mockResolvedValue({ status: "pending" });
    const openExternal = vi.fn(async () => "opened" as const);
    const closeExternal = vi.fn(async () => undefined);
    const googleIdentity = createGoogleIdentity();
    render(
      <AndroidCloudApp
        client={client}
        closeExternal={closeExternal}
        googleIdentity={googleIdentity}
        openExternal={openExternal}
        voice={createVoice()}
      />,
    );

    const signInButton = await screen.findByRole("button", {
      name: "Continue with Google",
    });
    expect(screen.getByTestId("android-cloud-first-run-greeting")).toBeTruthy();
    expect(screen.getByTestId("android-cloud-first-run-sign-in")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Sign in to start chatting"),
    ).toHaveProperty("disabled", true);
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(signInButton);
    await waitFor(() => expect(nativeSignIn).toHaveBeenCalledOnce());
    expect(nativeSignIn).toHaveBeenCalledWith(
      googleIdentity,
      expect.any(AbortSignal),
    );
    expect(await screen.findByText("Ada")).toBeTruthy();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens canonical Steward when another sign-in method is requested", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl:
        "https://cloud.eliza.app/auth/cli-login?session=10000000-0000-4000-8000-000000000001",
    });
    vi.spyOn(client, "pollLogin").mockResolvedValue({ status: "pending" });
    const openExternal = vi.fn(async () => "opened" as const);
    const closeExternal = vi.fn(async () => undefined);
    render(
      <AndroidCloudApp
        client={client}
        closeExternal={closeExternal}
        googleIdentity={createGoogleIdentity()}
        openExternal={openExternal}
        voice={createVoice()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Other sign-in options" }),
    );
    await waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    expect(openExternal).toHaveBeenCalledWith(
      "https://cloud.eliza.app/auth/cli-login?session=10000000-0000-4000-8000-000000000001",
    );
    expect(
      screen.queryByText(/Google|Discord|Telegram|magic link/i),
    ).toBeNull();
    expect(screen.getByText("Hi, I'm Eliza.")).toBeTruthy();
    expect(
      screen.getByText("Finish signing in with Steward, then return to Eliza."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(closeExternal).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
  });

  it("checks the pairing session after a native Custom Tab closes without background polling", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl:
        "https://cloud.eliza.app/auth/cli-login?session=10000000-0000-4000-8000-000000000001",
    });
    const pollLogin = vi
      .spyOn(client, "pollLogin")
      .mockResolvedValue({ status: "pending" });
    render(
      <AndroidCloudApp
        client={client}
        openExternal={async () => "closed" as const}
        voice={createVoice()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in to Eliza Cloud" }),
    );
    await waitFor(() => expect(pollLogin).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Sign in to Eliza Cloud" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
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
});
