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
import { CONNECT_EVENT } from "../../events";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

const { clientMock, tunnelCredentialMock, updateSecretsMock } = vi.hoisted(
  () => ({
    clientMock: {
      getPermission: vi.fn(),
      requestPermission: vi.fn(),
      openPermissionSettings: vi.fn(),
      updateSecrets: vi.fn(),
      tunnelCredential: vi.fn(),
    },
    tunnelCredentialMock: vi.fn(),
    updateSecretsMock: vi.fn(),
  }),
);

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
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
  const appValue = {
    t: (key: string) => key,
    sendActionMessage,
  } as never;
  // MessageContent reads context via the selector store, so seed it too.
  __setAppValueForTests(appValue);
  render(
    <AppContext.Provider value={appValue}>
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

function pendingTunnelSecretRequest(): ConversationMessage["secretRequest"] {
  return {
    key: "SUB_AGENT_CREDENTIALS",
    reason: "A child coding agent needs credentials to continue.",
    status: "pending",
    delivery: {
      mode: "inline_owner_app",
      instruction: "Enter it in this owner-only app form.",
      privateRouteRequired: true,
      canCollectValueInCurrentChannel: true,
      tunnel: {
        childSessionId: "pty-1-abc",
        credentialScopeId: "cred_scope_test",
        keys: ["OPENAI_API_KEY", "STRIPE_KEY"],
      },
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
        {
          name: "STRIPE_KEY",
          label: "STRIPE_KEY",
          input: "secret",
          required: true,
        },
      ],
      submitLabel: "Send to sub-agent",
      statusOnly: true,
    },
  };
}

function pendingOAuthRequest(): ConversationMessage["secretRequest"] {
  return {
    key: "GITHUB_OAUTH",
    reason: "Connect GitHub for PR access",
    status: "pending",
    delivery: {
      mode: "inline_owner_app",
      instruction: "Connect GitHub to continue.",
      privateRouteRequired: true,
      canCollectValueInCurrentChannel: true,
    },
    form: {
      type: "sensitive_request_form",
      kind: "oauth",
      mode: "inline_owner_app",
      fields: [],
      provider: "GitHub",
      scopes: ["repo", "read:user"],
      authorizationUrl: "https://example.test/oauth/authorize?state=abc",
      submitLabel: "Connect GitHub",
      statusOnly: true,
    },
  };
}

function pendingImageSecretRequest(): ConversationMessage["secretRequest"] {
  return {
    key: "TOTP_SEED_PHOTO",
    reason: "Photograph the 2FA seed",
    status: "pending",
    delivery: {
      mode: "inline_owner_app",
      instruction: "Upload a photo of the seed.",
      privateRouteRequired: true,
      canCollectValueInCurrentChannel: true,
    },
    form: {
      type: "sensitive_request_form",
      kind: "secret",
      mode: "inline_owner_app",
      fields: [
        {
          name: "seed_photo",
          label: "Seed photo",
          input: "image",
          required: true,
          mimeTypes: ["image/png"],
          maxBytes: 1_000_000,
        },
      ],
      submitLabel: "Upload",
      statusOnly: true,
    },
  };
}

function pendingRemoteConnectRequest(): ConversationMessage["secretRequest"] {
  return {
    key: "remote-agent",
    reason: "Connect to a remote agent by its URL and access token",
    status: "pending",
    delivery: {
      mode: "inline_owner_app",
      canCollectValueInCurrentChannel: true,
    },
    form: {
      type: "sensitive_request_form",
      kind: "remote_connect",
      mode: "inline_owner_app",
      fields: [
        {
          name: "url",
          label: "Remote agent URL",
          input: "text",
          required: true,
        },
        {
          name: "token",
          label: "Access token (optional)",
          input: "secret",
          required: false,
        },
      ],
      submitLabel: "Connect",
    },
  };
}

describe("MessageContent sensitive requests", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  beforeEach(() => {
    updateSecretsMock.mockReset();
    tunnelCredentialMock.mockReset();
    clientMock.updateSecrets.mockImplementation(updateSecretsMock);
    clientMock.tunnelCredential.mockImplementation(tunnelCredentialMock);
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
    // Trust-signage copy lives only on the OAuth panel where the user is
    // navigating to a third-party origin. For a password field, the
    // `type="password"` input is the signal — chatty reassurance copy was
    // intentionally removed.
    expect(screen.getByTestId("sensitive-request").textContent).not.toContain(
      "will not be sent",
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
    // Mutual exclusivity: a normal secret request never tunnels.
    expect(tunnelCredentialMock).not.toHaveBeenCalled();
  });

  it("submits tunneled sub-agent credentials through the tunnel endpoint instead of saving global secrets", async () => {
    tunnelCredentialMock.mockResolvedValue({
      ok: true,
      childSessionId: "pty-1-abc",
      credentialScopeId: "cred_scope_test",
      key: "OPENAI_API_KEY",
    });
    const { container } = render(
      <MessageContent
        message={baseMessage({ secretRequest: pendingTunnelSecretRequest() })}
      />,
    );
    expect(screen.getByText("Sub-agent credentials")).toBeTruthy();

    const openAiValue = ["sk", "openai", String(Date.now())].join("-");
    const stripeValue = ["sk", "stripe", String(Date.now())].join("-");
    fireEvent.change(screen.getByLabelText("OPENAI_API_KEY"), {
      target: { value: openAiValue },
    });
    fireEvent.change(screen.getByLabelText("STRIPE_KEY"), {
      target: { value: stripeValue },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to sub-agent" }));

    await waitFor(() => {
      expect(screen.getByTestId("sensitive-request-status").textContent).toBe(
        "Saved",
      );
    });

    expect(updateSecretsMock).not.toHaveBeenCalled();
    expect(tunnelCredentialMock).toHaveBeenCalledTimes(2);
    expect(tunnelCredentialMock).toHaveBeenNthCalledWith(1, {
      childSessionId: "pty-1-abc",
      credentialScopeId: "cred_scope_test",
      key: "OPENAI_API_KEY",
      value: openAiValue,
    });
    expect(tunnelCredentialMock).toHaveBeenNthCalledWith(2, {
      childSessionId: "pty-1-abc",
      credentialScopeId: "cred_scope_test",
      key: "STRIPE_KEY",
      value: stripeValue,
    });
    expect(container.textContent?.includes(openAiValue)).toBe(false);
    expect(container.textContent?.includes(stripeValue)).toBe(false);
    expect(screen.queryByLabelText("OPENAI_API_KEY")).toBeNull();
    expect(screen.queryByLabelText("STRIPE_KEY")).toBeNull();
  });

  it("renders an image field as a file input and delivers it via updateSecrets (#8910)", async () => {
    updateSecretsMock.mockResolvedValueOnce({
      ok: true,
      updated: ["seed_photo"],
    });
    render(
      <MessageContent
        message={baseMessage({ secretRequest: pendingImageSecretRequest() })}
      />,
    );

    const input = screen.getByTestId(
      "sensitive-request-file-seed_photo",
    ) as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/png");
    expect(input.getAttribute("capture")).toBe("environment");

    const file = new File([new Uint8Array([1, 2, 3])], "seed.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [file] } });

    // FileReader populates the value asynchronously; wait for the submit to enable.
    await waitFor(() => {
      expect(
        (screen.getByTestId("sensitive-request-submit") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId("sensitive-request-submit"));

    await waitFor(() => {
      expect(updateSecretsMock).toHaveBeenCalledTimes(1);
    });
    const payload = updateSecretsMock.mock.calls[0]?.[0] as Record<
      string,
      string
    >;
    expect(Object.keys(payload)).toEqual(["seed_photo"]);
    // Delivered as a data URL through the existing submit path.
    expect(payload.seed_photo.startsWith("data:image/png")).toBe(true);
  });

  it("renders a non-image file field as a file input without camera capture (#8910)", async () => {
    updateSecretsMock.mockResolvedValueOnce({ ok: true, updated: ["doc"] });
    const request = pendingImageSecretRequest();
    // Turn it into a generic file field (e.g. a keystore/backup file upload).
    const field = request?.form?.fields?.[0];
    if (field) {
      field.name = "doc";
      field.label = "Backup file";
      field.input = "file";
      field.mimeTypes = ["application/json"];
    }
    render(
      <MessageContent message={baseMessage({ secretRequest: request })} />,
    );

    const input = screen.getByTestId(
      "sensitive-request-file-doc",
    ) as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("application/json");
    // Non-image uploads must NOT force the rear camera.
    expect(input.getAttribute("capture")).toBeNull();

    const file = new File([new Uint8Array([1, 2, 3])], "backup.json", {
      type: "application/json",
    });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(
        (screen.getByTestId("sensitive-request-submit") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId("sensitive-request-submit"));
    await waitFor(() => {
      expect(updateSecretsMock).toHaveBeenCalledTimes(1);
    });
    const payload = updateSecretsMock.mock.calls[0]?.[0] as Record<
      string,
      string
    >;
    expect(payload.doc.startsWith("data:application/json")).toBe(true);
  });

  it("rejects an upload over maxBytes and does not submit (#8910)", async () => {
    const request = pendingImageSecretRequest();
    const field = request?.form?.fields?.[0];
    if (field) field.maxBytes = 3; // 3 bytes — a 4-byte file must be rejected.
    render(
      <MessageContent message={baseMessage({ secretRequest: request })} />,
    );

    const input = screen.getByTestId(
      "sensitive-request-file-seed_photo",
    ) as HTMLInputElement;
    const tooBig = new File([new Uint8Array([1, 2, 3, 4])], "big.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [tooBig] } });

    // The error surfaces and no value is captured, so submit stays disabled.
    await waitFor(() => {
      expect(screen.getByTestId("sensitive-request").textContent).toContain(
        "too large",
      );
    });
    expect(
      (screen.getByTestId("sensitive-request-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(updateSecretsMock).not.toHaveBeenCalled();
  });

  it("renders an OAuth request with a Connect button and never shows the URL in chat", () => {
    const { container } = render(
      <MessageContent
        message={baseMessage({ secretRequest: pendingOAuthRequest() })}
      />,
    );

    const button = screen.getByTestId("sensitive-request-oauth-start");
    expect(button.textContent).toBe("Connect GitHub");
    expect(container.textContent).toContain("Scopes: repo, read:user");
    expect(container.textContent).toContain("The token is stored securely");
    // The raw authorization URL must never leak into the chat surface.
    expect(
      container.textContent?.includes("example.test/oauth/authorize"),
    ).toBe(false);
    // The form is OAuth, so no password field is rendered.
    expect(screen.queryByLabelText("GITHUB_OAUTH")).toBeNull();
    // updateSecrets must never be called for an OAuth flow — the token
    // lands in the vault via the callback, never via chat.
    expect(updateSecretsMock).not.toHaveBeenCalled();
  });

  it("opens the authorization URL in a popup when the Connect button is clicked", () => {
    const fakePopup = { opener: { real: true } } as unknown as Window;
    const openMock = vi.fn().mockReturnValue(fakePopup);
    const originalOpen = window.open;
    window.open = openMock as typeof window.open;

    render(
      <MessageContent
        message={baseMessage({ secretRequest: pendingOAuthRequest() })}
      />,
    );

    fireEvent.click(screen.getByTestId("sensitive-request-oauth-start"));
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0]?.[0]).toBe(
      "https://example.test/oauth/authorize?state=abc",
    );
    // SECURITY: the features string MUST include `noreferrer` so the
    // consent origin can't read `document.referrer`. It must NOT include
    // `noopener`, since that forces window.open to return null and
    // destroys our popup-blocked signal. We additionally null out
    // `popup.opener` ourselves immediately after open.
    const features = String(openMock.mock.calls[0]?.[2] ?? "");
    expect(features).toContain("noreferrer");
    expect(features).not.toContain("noopener");
    expect((fakePopup as { opener: unknown }).opener).toBeNull();
    // The button flips to "Authorizing..." after a successful popup open.
    expect(
      screen.getByTestId("sensitive-request-oauth-start").textContent,
    ).toContain("Authorizing");

    window.open = originalOpen;
  });

  it("remote_connect submit dispatches CONNECT_EVENT with the normalized URL and never touches the secret store", async () => {
    const connectEvents: unknown[] = [];
    const onConnect = (event: Event) => {
      connectEvents.push((event as CustomEvent).detail);
    };
    document.addEventListener(CONNECT_EVENT, onConnect);

    render(
      <MessageContent
        message={baseMessage({ secretRequest: pendingRemoteConnectRequest() })}
      />,
    );

    const urlInput = screen.getByLabelText(
      "Remote agent URL",
    ) as HTMLInputElement;
    expect(urlInput.type).toBe("text");
    const tokenInput = screen.getByLabelText(
      "Access token (optional)",
    ) as HTMLInputElement;
    expect(tokenInput.type).toBe("password");

    // Trailing slash proves normalizeRemoteAgentUrl ran before dispatch.
    fireEvent.change(urlInput, {
      target: { value: "https://agent.example.com:31337/" },
    });
    fireEvent.change(tokenInput, { target: { value: "tok-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(screen.getByTestId("sensitive-request-status").textContent).toBe(
        "Saved",
      );
    });

    expect(connectEvents).toEqual([
      {
        gatewayUrl: "https://agent.example.com:31337",
        token: "tok-123",
        completeFirstRun: true,
        skipConfirm: true,
      },
    ]);
    // The URL + token point the app at a remote runtime — they must NEVER be
    // written to the agent secret store or tunneled.
    expect(updateSecretsMock).not.toHaveBeenCalled();
    expect(tunnelCredentialMock).not.toHaveBeenCalled();

    document.removeEventListener(CONNECT_EVENT, onConnect);
  });

  it("remote_connect omits an empty token from the CONNECT_EVENT detail", async () => {
    const connectEvents: unknown[] = [];
    const onConnect = (event: Event) => {
      connectEvents.push((event as CustomEvent).detail);
    };
    document.addEventListener(CONNECT_EVENT, onConnect);

    render(
      <MessageContent
        message={baseMessage({ secretRequest: pendingRemoteConnectRequest() })}
      />,
    );

    // The token field is optional — a URL alone can submit.
    fireEvent.change(screen.getByLabelText("Remote agent URL"), {
      target: { value: "agent.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(screen.getByTestId("sensitive-request-status").textContent).toBe(
        "Saved",
      );
    });

    expect(connectEvents).toEqual([
      {
        gatewayUrl: "https://agent.example.com",
        token: undefined,
        completeFirstRun: true,
        skipConfirm: true,
      },
    ]);
    expect(updateSecretsMock).not.toHaveBeenCalled();

    document.removeEventListener(CONNECT_EVENT, onConnect);
  });

  it("remote_connect surfaces an invalid-URL error, keeps the form editable, and does not dispatch", async () => {
    const connectEvents: unknown[] = [];
    const onConnect = (event: Event) => {
      connectEvents.push((event as CustomEvent).detail);
    };
    document.addEventListener(CONNECT_EVENT, onConnect);

    const { container } = render(
      <MessageContent
        message={baseMessage({ secretRequest: pendingRemoteConnectRequest() })}
      />,
    );

    fireEvent.change(screen.getByLabelText("Remote agent URL"), {
      target: { value: "ftp://agent.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(container.textContent).toContain(
        "Remote agents must use HTTP or HTTPS.",
      );
    });

    // No dispatch, no secret-store write, and the form is still pending +
    // editable so the user can correct the typo.
    expect(connectEvents).toEqual([]);
    expect(updateSecretsMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("sensitive-request-status").textContent).toBe(
      "Pending",
    );
    expect(screen.getByLabelText("Remote agent URL")).toBeTruthy();

    document.removeEventListener(CONNECT_EVENT, onConnect);
  });

  it("surfaces a clear error when the OAuth popup is blocked", () => {
    const openMock = vi.fn().mockReturnValue(null);
    const originalOpen = window.open;
    window.open = openMock as typeof window.open;

    const { container } = render(
      <MessageContent
        message={baseMessage({ secretRequest: pendingOAuthRequest() })}
      />,
    );
    fireEvent.click(screen.getByTestId("sensitive-request-oauth-start"));
    expect(container.textContent).toContain("Pop-up blocked");
    // No fallback message-stream emission on popup block.
    expect(updateSecretsMock).not.toHaveBeenCalled();

    window.open = originalOpen;
  });
});

describe("MessageContent permission cards", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
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
