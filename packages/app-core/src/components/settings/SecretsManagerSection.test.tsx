// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchSecretsManagerOpen,
  useSecretsManagerModalState,
} from "../../hooks/useSecretsManagerModal";
import {
  BackendRow,
  SavedLoginsPanel,
  VaultModal,
} from "./SecretsManagerSection";

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
        failures: [{ source: "1password", message: "session expired" }],
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

// ── VaultModal — tabbed shell ──────────────────────────────────────

describe("VaultModal — tabs + hash sync", () => {
  type RouteResponse = { status: number; body: unknown };
  type RouteHandler = (req: {
    method: string;
    url: string;
    body?: string;
  }) => RouteResponse;
  let routes: Map<string, RouteHandler>;

  function fakeFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const urlPath =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    let handler: RouteHandler | undefined = routes.get(`${method} ${urlPath}`);
    if (!handler) {
      for (const [pattern, h] of routes.entries()) {
        const [hMethod, hPath] = pattern.split(" ");
        if (hMethod !== method) continue;
        if (hPath?.endsWith("*") && urlPath.startsWith(hPath.slice(0, -1))) {
          handler = h;
          break;
        }
      }
    }
    if (!handler) {
      throw new Error(`fakeFetch: no handler for ${method} ${urlPath}`);
    }
    const result = handler({
      method,
      url: urlPath,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve(
      new Response(JSON.stringify(result.body), { status: result.status }),
    );
  }

  function setRoute(method: string, path: string, handler: RouteHandler) {
    routes.set(`${method} ${path}`, handler);
  }

  function seedDefaultRoutes() {
    setRoute("GET", "/api/secrets/manager/backends", () => ({
      status: 200,
      body: {
        backends: [
          {
            id: "in-house",
            label: "Local (encrypted)",
            available: true,
            signedIn: true,
          },
        ],
      },
    }));
    setRoute("GET", "/api/secrets/manager/preferences", () => ({
      status: 200,
      body: { preferences: { enabled: ["in-house"] } },
    }));
    setRoute("GET", "/api/secrets/manager/install/methods", () => ({
      status: 200,
      body: { methods: { "1password": [], bitwarden: [], protonpass: [] } },
    }));
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 200,
      body: { entries: [] },
    }));
    setRoute("GET", "/api/secrets/routing", () => ({
      status: 200,
      body: { config: { rules: [] } },
    }));
    setRoute("GET", "/api/agents", () => ({
      status: 200,
      body: { agents: [] },
    }));
    setRoute("GET", "/api/apps", () => ({
      status: 200,
      body: { apps: [] },
    }));
    setRoute("GET", "/api/secrets/logins", () => ({
      status: 200,
      body: { logins: [], failures: [] },
    }));
  }

  beforeEach(() => {
    routes = new Map();
    seedDefaultRoutes();
    vi.stubGlobal("fetch", fakeFetch as typeof fetch);
    if (typeof window !== "undefined") window.location.hash = "";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (typeof window !== "undefined") window.location.hash = "";
  });

  it("opens on Overview by default and renders all four tabs", async () => {
    render(<VaultModal open onOpenChange={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId("vault-tab-overview")).toBeTruthy();
    });
    expect(screen.getByTestId("vault-tab-secrets")).toBeTruthy();
    expect(screen.getByTestId("vault-tab-logins")).toBeTruthy();
    expect(screen.getByTestId("vault-tab-routing")).toBeTruthy();
    // Overview content visible.
    await waitFor(() => {
      expect(screen.getByText(/Local \(encrypted\)/i)).toBeTruthy();
    });
  });

  it("syncs the URL hash on tab change", async () => {
    const user = userEvent.setup();
    render(<VaultModal open onOpenChange={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId("vault-tab-secrets")).toBeTruthy();
    });
    await user.click(screen.getByTestId("vault-tab-secrets"));
    await waitFor(() => {
      expect(window.location.hash).toBe("#vault/secrets");
    });
    await user.click(screen.getByTestId("vault-tab-routing"));
    await waitFor(() => {
      expect(window.location.hash).toBe("#vault/routing");
    });
  });

  it("opens on the requested tab when dispatch carries one", async () => {
    function Mount() {
      // Mirror App.tsx's SecretsManagerModalRoot — forward initialTab
      // / focus props to VaultModal so the dispatch payload survives
      // the body's late mount.
      const state = useSecretsManagerModalState();
      return (
        <VaultModal
          open={state.isOpen}
          onOpenChange={state.setOpen}
          initialTab={state.initialTab}
          initialFocusKey={state.focusKey}
          initialFocusProfileId={state.focusProfileId}
          onConsumeInitial={state.clearFocus}
        />
      );
    }
    render(<Mount />);
    act(() => {
      dispatchSecretsManagerOpen({ tab: "logins" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("vault-tab-logins-content")).toBeTruthy();
    });
    expect(window.location.hash).toBe("#vault/logins");
  });

  it("restores prior hash on close", async () => {
    if (typeof window === "undefined") return;
    window.location.hash = "secrets"; // settings section anchor
    let isOpen = true;
    const { rerender } = render(
      <VaultModal open={isOpen} onOpenChange={(next) => (isOpen = next)} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("vault-tab-overview")).toBeTruthy();
    });
    expect(window.location.hash).toBe("#vault/overview");
    rerender(
      <VaultModal open={false} onOpenChange={(next) => (isOpen = next)} />,
    );
    await waitFor(() => {
      expect(window.location.hash).toBe("#secrets");
    });
  });

  it("cross-jump: Secrets → Routing pre-filters the rules list on the focused key", async () => {
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 200,
      body: {
        entries: [
          {
            key: "OPENROUTER_API_KEY",
            category: "provider",
            label: "OpenRouter",
            hasProfiles: true,
            activeProfile: "default",
            profiles: [
              { id: "default", label: "Default" },
              { id: "work", label: "Work" },
            ],
            kind: "secret",
          },
        ],
      },
    }));
    setRoute("GET", "/api/secrets/routing", () => ({
      status: 200,
      body: {
        config: {
          rules: [
            {
              keyPattern: "OPENROUTER_API_KEY",
              scope: { kind: "agent", agentId: "agent-A" },
              profileId: "work",
            },
          ],
        },
      },
    }));

    const user = userEvent.setup();
    render(<VaultModal open onOpenChange={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId("vault-tab-secrets")).toBeTruthy();
    });

    // Switch to Secrets, expand the row, click the routing-rules link.
    await user.click(screen.getByTestId("vault-tab-secrets"));
    await waitFor(() => {
      expect(
        screen.getByTestId("profile-badge-OPENROUTER_API_KEY"),
      ).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: /Expand/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Routing rules for OpenRouter/i }),
      ).toBeTruthy();
    });
    await user.click(
      screen.getByRole("button", { name: /Routing rules for OpenRouter/i }),
    );

    // Routing tab should now be active and the filter pre-set.
    await waitFor(() => {
      expect(screen.getByTestId("vault-tab-routing-content")).toBeTruthy();
    });
    const filter = screen.getByTestId(
      "routing-rules-filter",
    ) as HTMLInputElement;
    expect(filter.value).toBe("OPENROUTER_API_KEY");
  });
});
