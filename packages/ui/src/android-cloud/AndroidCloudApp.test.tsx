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
  ANDROID_CLOUD_DEEP_LINK_EVENT,
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

  it("offers one hosted Eliza Cloud path and restores the paired session", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(session);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      state: "state-1",
      browserUrl:
        "https://cloud.eliza.app/login?returnTo=%2Fapp-auth%2Fauthorize",
    });
    const completeLogin = vi
      .spyOn(client, "completeLogin")
      .mockResolvedValue(undefined);
    const acknowledge = vi.fn(async () => undefined);
    const openExternal = vi.fn(async () => "opened" as const);
    const closeExternal = vi.fn(async () => undefined);
    render(
      <AndroidCloudApp
        client={client}
        closeExternal={closeExternal}
        openExternal={openExternal}
        voice={createVoice()}
      />,
    );

    const signInButton = await screen.findByRole("button", {
      name: "Sign in with Eliza Cloud",
    });
    expect(screen.getByTestId("android-cloud-first-run-greeting")).toBeTruthy();
    expect(screen.getByTestId("android-cloud-first-run-sign-in")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Sign in to start chatting"),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByText("Other sign-in options")).toBeNull();
    expect(screen.queryByText("Check for an existing session")).toBeNull();
    expect(screen.queryByText("Continue with Google")).toBeNull();
    fireEvent.click(signInButton);
    await waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    expect(openExternal).toHaveBeenCalledWith(
      "https://cloud.eliza.app/login?returnTo=%2Fapp-auth%2Fauthorize",
    );
    act(() => {
      document.dispatchEvent(
        new CustomEvent(ANDROID_CLOUD_DEEP_LINK_EVENT, {
          detail: {
            url: "elizaos://auth/callback?code=code-1&state=state-1",
            acknowledge,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(completeLogin).toHaveBeenCalledWith(
        "elizaos://auth/callback?code=code-1&state=state-1",
      ),
    );
    expect(closeExternal).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(await screen.findByText("Ada")).toBeTruthy();
  });

  it("surfaces a hosted sign-in launch failure without adding fallback choices", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    vi.spyOn(client, "beginLogin").mockRejectedValue(
      new Error("Eliza Cloud sign-in is temporarily unavailable."),
    );
    render(
      <AndroidCloudApp
        client={client}
        openExternal={vi.fn(async () => "closed" as const)}
        voice={createVoice()}
      />,
    );

    const button = await screen.findByRole("button", {
      name: "Sign in with Eliza Cloud",
    });
    fireEvent.click(button);
    expect(
      await screen.findByText(
        "Eliza Cloud sign-in is temporarily unavailable.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Other sign-in options")).toBeNull();
    expect(screen.queryByText("Check for an existing session")).toBeNull();
  });

  it("lets the user cancel a hosted sign-in session", async () => {
    const client = createClient();
    vi.spyOn(client, "restoreSession").mockResolvedValue(null);
    vi.spyOn(client, "beginLogin").mockResolvedValue({
      state: "state-1",
      browserUrl:
        "https://cloud.eliza.app/login?returnTo=%2Fapp-auth%2Fauthorize",
    });
    const cancelLogin = vi.spyOn(client, "cancelLogin");
    const openExternal = vi.fn(async () => "opened" as const);
    const closeExternal = vi.fn(async () => undefined);
    render(
      <AndroidCloudApp
        client={client}
        closeExternal={closeExternal}
        openExternal={openExternal}
        voice={createVoice()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Eliza Cloud" }),
    );
    await screen.findByRole("button", { name: "Cancel sign-in" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(closeExternal).toHaveBeenCalledOnce());
    expect(cancelLogin).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Sign in with Eliza Cloud" }),
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
