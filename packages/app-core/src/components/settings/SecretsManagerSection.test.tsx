// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendRow, SavedLoginsPanel } from "./SecretsManagerSection";

afterEach(cleanup);

const noop = () => undefined;

const baseRowProps = {
  enabled: true,
  isPrimary: false,
  position: 1,
  totalEnabled: 2,
  methods: [],
  installSheetOpen: false,
  signinSheetOpen: false,
  onToggle: noop,
  onMoveUp: noop,
  onMoveDown: noop,
  onOpenInstallSheet: noop,
  onOpenSigninSheet: noop,
  onCloseSheets: noop,
  onInstallComplete: noop,
  onSigninComplete: noop,
  onSignout: noop,
};

describe("BackendRow — three external states", () => {
  it("renders an Install button when the backend is not available", () => {
    const onOpenInstallSheet = vi.fn();
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "bitwarden",
          label: "Bitwarden",
          available: false,
          detail: "`bw` CLI not installed.",
        }}
        enabled={false}
        onOpenInstallSheet={onOpenInstallSheet}
      />,
    );
    const button = screen.getByRole("button", { name: /Install Bitwarden/i });
    expect(button).toBeTruthy();
    button.click();
    expect(onOpenInstallSheet).toHaveBeenCalledTimes(1);
    // No reorder buttons in not-available state.
    expect(screen.queryByRole("button", { name: /Move up/i })).toBeNull();
  });

  it("renders a Sign in button when the backend is detected but not signed in", () => {
    const onOpenSigninSheet = vi.fn();
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "1password",
          label: "1Password",
          available: true,
          signedIn: false,
          detail: "`op` is installed but not signed in.",
        }}
        onOpenSigninSheet={onOpenSigninSheet}
      />,
    );
    const button = screen.getByRole("button", {
      name: /Sign in to 1Password/i,
    });
    expect(button).toBeTruthy();
    button.click();
    expect(onOpenSigninSheet).toHaveBeenCalledTimes(1);
  });

  it("renders Sign out + reorder when the backend is signed in", () => {
    const onSignout = vi.fn();
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "1password",
          label: "1Password",
          available: true,
          signedIn: true,
        }}
        position={0}
        totalEnabled={2}
        onSignout={onSignout}
      />,
    );
    const signOut = screen.getByRole("button", {
      name: /Sign out of 1Password/i,
    });
    expect(signOut).toBeTruthy();
    signOut.click();
    expect(onSignout).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Move up/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Move down/i })).toBeTruthy();
  });

  it("does not show install/signin buttons for the in-house backend", () => {
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "in-house",
          label: "Milady (local, encrypted)",
          available: true,
          signedIn: true,
        }}
        position={0}
      />,
    );
    expect(screen.queryByRole("button", { name: /Install/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign out/i })).toBeNull();
  });

  it("renders the inline install sheet when installSheetOpen", () => {
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "bitwarden",
          label: "Bitwarden",
          available: false,
        }}
        enabled={false}
        installSheetOpen={true}
        methods={[
          { kind: "brew", package: "bitwarden-cli", cask: false },
          { kind: "npm", package: "@bitwarden/cli" },
        ]}
      />,
    );
    expect(screen.getByText(/brew install bitwarden-cli/i)).toBeTruthy();
    expect(screen.getByText(/npm install -g @bitwarden\/cli/i)).toBeTruthy();
  });

  it("renders the inline sign-in form when signinSheetOpen for 1Password", () => {
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "1password",
          label: "1Password",
          available: true,
          signedIn: false,
        }}
        signinSheetOpen={true}
      />,
    );
    expect(screen.getByLabelText(/Email/i)).toBeTruthy();
    expect(screen.getByLabelText(/Secret key/i)).toBeTruthy();
    expect(screen.getByLabelText(/Master password/i)).toBeTruthy();
    // The master password input is type=password.
    const pwd = screen.getByLabelText(/Master password/i);
    expect((pwd as HTMLInputElement).type).toBe("password");
  });
});

describe("SavedLoginsPanel", () => {
  type FetchMock = ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: FetchMock;

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the empty state when no logins are saved", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, logins: [], failures: [] }),
    );
    render(<SavedLoginsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("saved-logins-empty")).toBeTruthy();
    });
    expect(screen.queryByTestId("saved-logins-list")).toBeNull();
  });

  it("renders the list of saved logins with relative timestamps", async () => {
    const now = Date.now();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        logins: [
          {
            source: "in-house",
            identifier: "github.com:alice",
            domain: "github.com",
            username: "alice",
            title: "alice",
            updatedAt: now - 60_000,
          },
          {
            source: "in-house",
            identifier: "gitlab.com:bob",
            domain: "gitlab.com",
            username: "bob",
            title: "bob",
            updatedAt: now - 3_600_000,
          },
        ],
        failures: [],
      }),
    );
    render(<SavedLoginsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("saved-logins-list")).toBeTruthy();
    });
    // Title is the username for in-house entries, with the domain shown
    // in a parenthetical when it differs from the title.
    expect(screen.getByText(/alice ·/)).toBeTruthy();
    expect(screen.getByText(/bob ·/)).toBeTruthy();
    expect(screen.getByText("(github.com)")).toBeTruthy();
    expect(screen.getByText("(gitlab.com)")).toBeTruthy();
  });

  it("renders source pills for external entries", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        logins: [
          {
            source: "1password",
            identifier: "abc123",
            domain: "github.com",
            username: "alice",
            title: "GitHub Personal",
            updatedAt: Date.now() - 7 * 86_400_000,
          },
          {
            source: "bitwarden",
            identifier: "bw-xyz",
            domain: "gitlab.com",
            username: "bob",
            title: "GitLab",
            updatedAt: Date.now() - 86_400_000,
          },
        ],
        failures: [],
      }),
    );
    render(<SavedLoginsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("saved-logins-list")).toBeTruthy();
    });
    expect(screen.getByText("1Password")).toBeTruthy();
    expect(screen.getByText("Bitwarden")).toBeTruthy();
    expect(screen.getByText("GitHub Personal")).toBeTruthy();
    expect(screen.getByText("GitLab")).toBeTruthy();
  });

  it("renders a backend failure row when the API reports one", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        logins: [],
        failures: [
          { source: "1password", message: "session expired" },
        ],
      }),
    );
    render(<SavedLoginsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("saved-logins-failures")).toBeTruthy();
    });
    expect(
      screen.getByText(/1Password failed to load: session expired/),
    ).toBeTruthy();
  });

  it("submits the add form and refreshes the list", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true, logins: [], failures: [] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          logins: [
            {
              source: "in-house",
              identifier: "github.com:alice",
              domain: "github.com",
              username: "alice",
              title: "alice",
              updatedAt: Date.now(),
            },
          ],
          failures: [],
        }),
      );

    render(<SavedLoginsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("saved-logins-empty")).toBeTruthy();
    });

    const addBtn = screen.getByRole("button", { name: /Add login/i });
    fireEvent.click(addBtn);
    expect(screen.getByTestId("saved-logins-add-form")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("github.com"), {
      target: { value: "github.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("alice@example.com"), {
      target: { value: "alice" },
    });
    // The password Input is the only `type=password` field in the panel.
    const form = screen.getByTestId("saved-logins-add-form");
    const pwd = form.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    fireEvent.change(pwd, { target: { value: "hunter2" } });

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      // After refresh: in-house entry renders title "alice" with the
      // domain shown in a parenthetical "(github.com)".
      expect(screen.getByText("(github.com)")).toBeTruthy();
    });
    // First call: initial GET. Second: POST. Third: refresh GET.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postCall = fetchMock.mock.calls[1];
    expect(postCall?.[0]).toBe("/api/secrets/logins");
    expect((postCall?.[1] as RequestInit | undefined)?.method).toBe("POST");
    const body = JSON.parse(
      String((postCall?.[1] as RequestInit | undefined)?.body ?? "{}"),
    ) as { domain: string; username: string; password: string };
    expect(body.domain).toBe("github.com");
    expect(body.username).toBe("alice");
    expect(body.password).toBe("hunter2");
  });
});
