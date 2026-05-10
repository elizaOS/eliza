// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";

const { updateSecretsMock } = vi.hoisted(() => ({
  updateSecretsMock: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../../api/client", () => ({
  client: {
    updateSecrets: updateSecretsMock,
  },
}));

import { MessageContent } from "./MessageContent";

function baseMessage(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id: "message-1",
    role: "assistant",
    text: "Fallback text that should not render for a sensitive request.",
    timestamp: Date.now(),
    ...overrides,
  };
}

function pendingPublicSecretRequest(): ConversationMessage["secretRequest"] {
  return {
    key: "OPENAI_API_KEY",
    status: "pending",
    delivery: {
      mode: "dm_or_owner_app_instruction",
      instruction: "Open the owner app or use a private DM to continue.",
      privateRouteRequired: true,
      canCollectValueInCurrentChannel: false,
    },
  };
}

function pendingOwnerInlineSecretRequest(): ConversationMessage["secretRequest"] {
  return {
    key: "OPENAI_API_KEY",
    reason: "Provider setup",
    status: "pending",
    delivery: {
      mode: "inline_owner_app",
      instruction: "Enter it in this owner-only app form.",
      privateRouteRequired: true,
      canCollectValueInCurrentChannel: true,
    },
    form: {
      type: "sensitive_request_form",
      kind: "secret",
      mode: "inline_owner_app",
      fields: [
        {
          name: "OPENAI_API_KEY",
          label: "OPENAI_API_KEY",
          input: "secret",
          required: true,
        },
      ],
      submitLabel: "Save secret",
      statusOnly: true,
    },
  };
}

describe("MessageContent sensitive requests", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    updateSecretsMock.mockReset();
  });

  it("renders public requests as status-only without an input", () => {
    render(
      <MessageContent
        message={baseMessage({ secretRequest: pendingPublicSecretRequest() })}
      />,
    );

    expect(screen.getByTestId("sensitive-request-status").textContent).toBe(
      "Pending",
    );
    expect(screen.queryByLabelText("OPENAI_API_KEY")).toBeNull();
    expect(screen.getByTestId("sensitive-request").textContent).toContain(
      "Open the owner app",
    );
    expect(
      screen.queryByText(
        "Fallback text that should not render for a sensitive request.",
      ),
    ).toBeNull();
  });

  it("renders owner-private inline requests as a private form descriptor", () => {
    render(
      <MessageContent
        message={baseMessage({
          secretRequest: pendingOwnerInlineSecretRequest(),
        })}
      />,
    );

    const input = screen.getByLabelText("OPENAI_API_KEY") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByRole("button", { name: "Save secret" })).toBeTruthy();
    expect(screen.getByTestId("sensitive-request").textContent).toContain(
      "The value will not be sent as a chat message.",
    );
  });

  it("shows success status without rendering the submitted value", async () => {
    updateSecretsMock.mockResolvedValueOnce({
      ok: true,
      updated: ["OPENAI_API_KEY"],
    });
    const rawSecret = ["test", "secret", String(Date.now())].join("-");
    const { container } = render(
      <MessageContent
        message={baseMessage({
          secretRequest: pendingOwnerInlineSecretRequest(),
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText("OPENAI_API_KEY"), {
      target: { value: rawSecret },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));

    await waitFor(() => {
      expect(screen.getByTestId("sensitive-request-status").textContent).toBe(
        "Saved",
      );
    });

    expect(updateSecretsMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(updateSecretsMock.mock.calls[0]?.[0] ?? {})).toEqual([
      "OPENAI_API_KEY",
    ]);
    expect(container.textContent?.includes(rawSecret)).toBe(false);
    expect(screen.queryByLabelText("OPENAI_API_KEY")).toBeNull();
  });
});
