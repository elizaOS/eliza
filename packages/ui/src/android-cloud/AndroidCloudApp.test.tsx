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

function createGoogleIdentity() {
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

  it("renders a retryable signed-out state when no stored session exists", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    render(<AndroidCloudApp client={client} voice={createVoice()} />);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(
      screen.getByText("Sign in securely to chat with your Eliza."),
    ).toBeTruthy();
  });

  it("keeps native sign-in failures in the app without offering a session retry", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    vi.spyOn(client, "signInWithGoogle").mockRejectedValue(
      new Error("Eliza Cloud sign-in is not configured for this app yet."),
    );
    const googleIdentity = createGoogleIdentity();
    render(
      <AndroidCloudApp
        client={client}
        googleIdentity={googleIdentity}
        voice={createVoice()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    );

    expect(
      await screen.findByText(
        "Eliza Cloud sign-in is not configured for this app yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry session check" })).toBe(
      null,
    );
  });

  it("renders Google's pre-approved neutral control at its authored geometry", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    render(
      <AndroidCloudApp
        client={client}
        googleIdentity={createGoogleIdentity()}
        voice={createVoice()}
      />,
    );

    const button = await screen.findByRole("button", {
      name: "Sign in with Google",
    });
    expect(button.className).toContain("min-h-12");
    const asset = screen.getByTestId("google-sign-in-neutral-asset");
    expect(asset.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(asset.getAttribute("width")).toBe("180");
    expect(asset.getAttribute("height")).toBe("40");
  });

  it("treats native account-chooser dismissal as quiet cancellation", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    vi.spyOn(client, "signInWithGoogle").mockRejectedValue(
      Object.assign(new Error("Google sign-in was cancelled."), {
        code: "GOOGLE_SIGN_IN_CANCELLED",
      }),
    );
    render(
      <AndroidCloudApp
        client={client}
        googleIdentity={createGoogleIdentity()}
        voice={createVoice()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sign in with Google" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancels native Credential Manager without closing a browser", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    let rejectSignIn: ((error: Error) => void) | undefined;
    vi.spyOn(client, "signInWithGoogle").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSignIn = reject;
        }),
    );
    const googleIdentity = createGoogleIdentity();
    googleIdentity.cancel.mockImplementation(async () => {
      rejectSignIn?.(new Error("Google sign-in was cancelled."));
    });
    const closeExternal = vi.fn(async () => undefined);
    render(
      <AndroidCloudApp
        client={client}
        closeExternal={closeExternal}
        googleIdentity={googleIdentity}
        voice={createVoice()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Google" }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(
      "Opening Google account chooser…",
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel sign-in" }),
    );

    await waitFor(() => expect(googleIdentity.cancel).toHaveBeenCalledOnce());
    const nativeSignal = vi.mocked(client.signInWithGoogle).mock.calls[0]?.[1];
    expect(nativeSignal?.aborted).toBe(true);
    expect(closeExternal).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancels browser sign-in without invoking native cancellation", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      sessionId: "10000000-0000-4000-8000-000000000001",
      browserUrl: "https://cloud.eliza.app/auth/cli-login",
    });
    const openExternal = vi.fn(async () => undefined);
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

    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in browser" }),
    );
    await waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));

    await waitFor(() => expect(closeExternal).toHaveBeenCalledOnce());
    expect(googleIdentity.cancel).not.toHaveBeenCalled();
  });

  it("clears Google credential state after the Cloud session signs out", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(session);
    vi.spyOn(client, "signOut").mockResolvedValue(undefined);
    const googleIdentity = createGoogleIdentity();
    render(
      <AndroidCloudApp
        client={client}
        googleIdentity={googleIdentity}
        voice={createVoice()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() =>
      expect(googleIdentity.clearCredentialState).toHaveBeenCalledOnce(),
    );
    expect(
      screen.getByRole("button", { name: "Sign in with Google" }),
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
});
