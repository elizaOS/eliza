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

  it("opens the canonical Steward sign-in without rendering a second provider picker", async () => {
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
        openExternal={openExternal}
        voice={createVoice()}
      />,
    );

    await waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    expect(openExternal).toHaveBeenCalledWith(
      "https://cloud.eliza.app/auth/cli-login?session=10000000-0000-4000-8000-000000000001",
    );
    expect(
      screen.queryByText(/Google|Discord|Telegram|magic link/i),
    ).toBeNull();
    expect(
      screen.getByText("Finish signing in with Steward to continue."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(closeExternal).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Open Eliza Cloud sign-in" }),
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

    await waitFor(() => expect(pollLogin).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Open Eliza Cloud sign-in" }),
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
