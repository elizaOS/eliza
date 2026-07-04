// @vitest-environment jsdom
//
// Render test for AccountConnectBlock: a provider row + Add-account button per
// offered connector, the live per-provider account count, and opening the
// AddAccountDialog on click. jsdom + Testing Library with the API client
// (listAccounts) hoisted-mocked — no network.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

const { clientMock, listAccountsMock } = vi.hoisted(() => ({
  clientMock: {
    listAccounts: vi.fn(),
    // AddAccountDialog touches these on mount/cleanup; stub them so the real
    // dialog renders without throwing when it opens.
    cancelAccountOAuth: vi.fn(),
    startAccountOAuth: vi.fn(),
  },
  listAccountsMock: vi.fn(),
}));

// AddAccountDialog opens a real browser popup for OAuth; the block test never
// clicks through the OAuth flow, so we only need the dialog to render.
vi.mock("../../api/client", () => ({
  client: clientMock,
}));

vi.mock("../../utils/event-source", () => ({
  openEventSource: () => null,
}));

vi.mock("../../utils", async () => {
  const actual =
    await vi.importActual<typeof import("../../utils")>("../../utils");
  return {
    ...actual,
    preOpenWindow: () => null,
    navigatePreOpenedWindow: () => {},
  };
});

import { MessageContent } from "./MessageContent";

function accountsResponse(claude: number, codex: number) {
  const makeAccounts = (providerId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${providerId}-${i}`,
      providerId,
      label: `${providerId} #${i}`,
      priority: i,
      enabled: true,
      source: "oauth",
      hasCredential: true,
    }));
  return {
    providers: [
      {
        providerId: "anthropic-subscription",
        strategy: "round-robin",
        accounts: makeAccounts("anthropic-subscription", claude),
      },
      {
        providerId: "openai-codex",
        strategy: "round-robin",
        accounts: makeAccounts("openai-codex", codex),
      },
    ],
  };
}

function baseMessage(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id: "message-1",
    role: "assistant",
    text: "Fallback text that should not render for an account-connect request.",
    timestamp: Date.now(),
    ...overrides,
  };
}

function accountConnectMessage(): ConversationMessage["accountConnect"] {
  return {
    providers: ["anthropic-subscription", "openai-codex"],
    reason: "You asked to connect another provider account.",
  };
}

function renderWithApp(message: ConversationMessage) {
  const appValue = {
    // Use the provided defaultValue so labels render as real English.
    t: (_key: string, vars?: Record<string, unknown>) => {
      const dv = vars?.defaultValue;
      if (typeof dv !== "string") return _key;
      return dv.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
        vars && vars[name] != null ? String(vars[name]) : "",
      );
    },
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  render(
    <AppContext.Provider value={appValue}>
      <MessageContent message={message} />
    </AppContext.Provider>,
  );
}

describe("AccountConnectBlock", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
    vi.clearAllMocks();
  });

  beforeEach(() => {
    clientMock.listAccounts.mockImplementation(listAccountsMock);
    clientMock.cancelAccountOAuth.mockResolvedValue(undefined);
    listAccountsMock.mockResolvedValue(accountsResponse(1, 1));
  });

  it("renders a provider row with an Add account button for each offered provider", async () => {
    renderWithApp(baseMessage({ accountConnect: accountConnectMessage() }));

    // The block replaces the fallback text.
    expect(
      screen.queryByText(
        "Fallback text that should not render for an account-connect request.",
      ),
    ).toBeNull();
    expect(screen.getByTestId("account-connect")).toBeTruthy();

    expect(
      screen.getByTestId("account-connect-row-anthropic-subscription"),
    ).toBeTruthy();
    expect(screen.getByTestId("account-connect-row-openai-codex")).toBeTruthy();

    expect(
      screen.getByTestId("account-connect-add-anthropic-subscription"),
    ).toBeTruthy();
    expect(screen.getByTestId("account-connect-add-openai-codex")).toBeTruthy();
    expect(screen.getByText("Claude Subscription")).toBeTruthy();
    expect(screen.getByText("OpenAI Codex")).toBeTruthy();
  });

  it("shows the live account count from the api client per provider", async () => {
    listAccountsMock.mockResolvedValue(accountsResponse(1, 1));
    renderWithApp(baseMessage({ accountConnect: accountConnectMessage() }));

    await waitFor(() => expect(listAccountsMock).toHaveBeenCalled());

    const claudeRow = await screen.findByTestId(
      "account-connect-row-anthropic-subscription",
    );
    const codexRow = screen.getByTestId("account-connect-row-openai-codex");
    await waitFor(() => {
      expect(within(claudeRow).getByText("1 connected")).toBeTruthy();
      expect(within(codexRow).getByText("1 connected")).toBeTruthy();
    });
  });

  it("opens AddAccountDialog when an Add account button is clicked", async () => {
    renderWithApp(baseMessage({ accountConnect: accountConnectMessage() }));

    // No dialog before the click.
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(
      screen.getByTestId("account-connect-add-anthropic-subscription"),
    );

    // AddAccountDialog renders a Radix dialog with an "Add …account" title for
    // the provider (the dialog owns its own copy). Assert on the dialog's
    // text content so the check is robust to how the title node is split.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.textContent ?? "").toMatch(/Add .*account/i);
  });

  it("renders only the offered providers (single-provider request)", async () => {
    renderWithApp(
      baseMessage({
        accountConnect: {
          providers: ["openai-codex"],
          reason: "You asked to connect another OpenAI Codex account.",
        },
      }),
    );

    const block = screen.getByTestId("account-connect");
    expect(
      within(block).getByTestId("account-connect-row-openai-codex"),
    ).toBeTruthy();
    expect(
      within(block).queryByTestId("account-connect-row-anthropic-subscription"),
    ).toBeNull();
    // The agent-supplied reason renders as the block subheading.
    expect(
      within(block).getByText(
        "You asked to connect another OpenAI Codex account.",
      ),
    ).toBeTruthy();
  });
});
