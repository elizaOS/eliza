// @vitest-environment jsdom

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
});
