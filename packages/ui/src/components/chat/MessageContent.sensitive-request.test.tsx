// @vitest-environment jsdom

import type { PermissionState } from "@elizaos/shared";
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
import { AppContext } from "../../state/useApp";

const { clientMock, updateSecretsMock } = vi.hoisted(() => ({
  clientMock: {
    getPermission: vi.fn(),
    requestPermission: vi.fn(),
    openPermissionSettings: vi.fn(),
    updateSecrets: vi.fn(),
  },
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
  client: clientMock,
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

function permissionState(
  overrides: Partial<PermissionState> = {},
): PermissionState {
  return {
    id: "reminders",
    status: "not-determined",
    lastChecked: 1,
    canRequest: true,
    platform: "darwin",
    ...overrides,
  };
}

function renderWithApp(
  message: ConversationMessage,
  sendActionMessage = vi.fn(),
) {
  render(
    <AppContext.Provider
      value={
        {
          t: (key: string) => key,
          sendActionMessage,
        } as never
      }
    >
      <MessageContent message={message} />
    </AppContext.Provider>,
  );
  return { sendActionMessage };
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
    clientMock.updateSecrets.mockImplementation(updateSecretsMock);
    clientMock.getPermission.mockResolvedValue(permissionState());
    clientMock.requestPermission.mockResolvedValue(
      permissionState({ status: "granted", canRequest: false }),
    );
    clientMock.openPermissionSettings.mockResolvedValue(undefined);
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

describe("MessageContent permission cards", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getPermission.mockResolvedValue(permissionState());
    clientMock.requestPermission.mockResolvedValue(
      permissionState({ status: "granted", canRequest: false }),
    );
    clientMock.openPermissionSettings.mockResolvedValue(undefined);
  });

  it("renders permission_request as an inline card and hides the JSON block", async () => {
    const text =
      "I need access before I can add that.\n```json\n" +
      JSON.stringify({
        action: "permission_request",
        reasoning: "Apple Reminders needs user approval.",
        permission: "reminders",
        reason: "I need access to Apple Reminders to add this reminder.",
        feature: "lifeops.reminders.create",
        fallback_offered: true,
      }) +
      "\n```";

    renderWithApp(baseMessage({ text }));

    expect(await screen.findByTestId("permission-card")).toBeTruthy();
    expect(screen.getByText("Apple Reminders")).toBeTruthy();
    expect(
      screen.getByText("I need access before I can add that."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("permission_request");
    expect(
      screen.getByTestId("permission-card-fallback").textContent,
    ).toContain("Use internal reminder");
  });

  it("sends fallback and granted action messages back through chat", async () => {
    const text =
      "I need access before I can add that.\n```json\n" +
      JSON.stringify({
        action: "permission_request",
        permission: "reminders",
        reason: "I need access to Apple Reminders to add this reminder.",
        feature: "lifeops.reminders.create",
        fallback_offered: true,
      }) +
      "\n```";
    const sendActionMessage = vi.fn();

    renderWithApp(baseMessage({ text }), sendActionMessage);
    fireEvent.click(await screen.findByTestId("permission-card-fallback"));

    expect(sendActionMessage).toHaveBeenCalledWith(
      "__permission_card__:use_fallback feature=lifeops.reminders.create permission=reminders",
    );

    cleanup();
    renderWithApp(baseMessage({ text }), sendActionMessage);
    fireEvent.click(await screen.findByTestId("permission-card-primary"));

    await waitFor(() =>
      expect(sendActionMessage).toHaveBeenCalledWith(
        "__permission_card__:granted feature=lifeops.reminders.create permission=reminders",
      ),
    );
  });
});
