// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultInventoryPanel } from "./VaultInventoryPanel";

interface VaultEntryMeta {
  key: string;
  category:
    | "provider"
    | "plugin"
    | "wallet"
    | "credential"
    | "system"
    | "session";
  label: string;
  providerId?: string;
  hasProfiles: boolean;
  activeProfile?: string;
  profiles?: Array<{ id: string; label: string }>;
  kind: "secret" | "value" | "reference";
}

interface RouteResponse {
  status: number;
  body: unknown;
}
type RouteHandler = (
  req: { method: string; body?: string; url: string },
) => RouteResponse;

let routes: Map<string, RouteHandler>;

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const urlPath = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.pathname
      : new URL(input.url).pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  // Match by exact pathname, then by leading prefix that maps to a parametrized route.
  let handler: RouteHandler | undefined = routes.get(`${method} ${urlPath}`);
  if (!handler) {
    for (const [pattern, h] of routes.entries()) {
      const [hMethod, hPath] = pattern.split(" ");
      if (hMethod !== method) continue;
      if (hPath && hPath.endsWith("*") && urlPath.startsWith(hPath.slice(0, -1))) {
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
    body: typeof init?.body === "string" ? init.body : undefined,
    url: urlPath,
  });
  const responseInit: ResponseInit = { status: result.status };
  return Promise.resolve(
    new Response(JSON.stringify(result.body), responseInit),
  );
}

function setRoute(method: string, path: string, handler: RouteHandler) {
  routes.set(`${method} ${path}`, handler);
}

beforeEach(() => {
  routes = new Map();
  vi.stubGlobal("fetch", fakeFetch as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VaultInventoryPanel — list", () => {
  it("groups entries by category", async () => {
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 200,
      body: {
        entries: [
          {
            key: "OPENROUTER_API_KEY",
            category: "provider",
            label: "OpenRouter",
            providerId: "openrouter",
            hasProfiles: false,
            kind: "secret",
          },
          {
            key: "EVM_PRIVATE_KEY",
            category: "wallet",
            label: "EVM_PRIVATE_KEY",
            hasProfiles: false,
            kind: "secret",
          },
          {
            key: "N8N_API_KEY",
            category: "plugin",
            label: "N8N_API_KEY",
            hasProfiles: false,
            kind: "secret",
          },
        ] satisfies VaultEntryMeta[],
      },
    }));

    render(<VaultInventoryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("vault-category-provider")).toBeTruthy();
      expect(screen.getByTestId("vault-category-wallet")).toBeTruthy();
      expect(screen.getByTestId("vault-category-plugin")).toBeTruthy();
    });
  });

  it("renders empty state when no entries exist", async () => {
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 200,
      body: { entries: [] },
    }));
    render(<VaultInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("vault-inventory-empty")).toBeTruthy();
    });
  });

  it("surfaces load failure without losing the UI shell", async () => {
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 500,
      body: { error: "boom" },
    }));
    render(<VaultInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("vault-inventory-error")).toBeTruthy();
    });
  });
});

describe("VaultInventoryPanel — reveal flow", () => {
  it("hits GET /api/secrets/inventory/:key and shows the value", async () => {
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 200,
      body: {
        entries: [
          {
            key: "OPENROUTER_API_KEY",
            category: "provider",
            label: "OpenRouter",
            hasProfiles: false,
            kind: "secret",
          },
        ] satisfies VaultEntryMeta[],
      },
    }));
    setRoute("GET", "/api/secrets/inventory/OPENROUTER_API_KEY", () => ({
      status: 200,
      body: { value: "sk-or-real-key", source: "bare" },
    }));

    render(<VaultInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Reveal OpenRouter/i })).toBeTruthy();
    });

    const revealBtn = screen.getByRole("button", { name: /Reveal OpenRouter/i });
    fireEvent.click(revealBtn);

    await waitFor(() => {
      const revealedRow = screen.getByTestId(
        "vault-revealed-OPENROUTER_API_KEY",
      );
      expect(revealedRow.textContent).toContain("sk-or-real-key");
    });
  });
});

describe("VaultInventoryPanel — add secret", () => {
  it("PUTs to /api/secrets/inventory/:key and reloads", async () => {
    let firstLoad = true;
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 200,
      body: {
        entries: firstLoad
          ? []
          : ([
              {
                key: "ANTHROPIC_API_KEY",
                category: "provider",
                label: "Anthropic",
                hasProfiles: false,
                kind: "secret",
              },
            ] satisfies VaultEntryMeta[]),
      },
    }));
    let putBody: string | undefined;
    setRoute("PUT", "/api/secrets/inventory/ANTHROPIC_API_KEY", (req) => {
      putBody = req.body;
      firstLoad = false;
      return { status: 200, body: { ok: true } };
    });

    render(<VaultInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("vault-inventory-empty")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add secret/i }));
    expect(screen.getByTestId("vault-add-secret-form")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("OPENROUTER_API_KEY"), {
      target: { value: "ANTHROPIC_API_KEY" },
    });
    fireEvent.change(screen.getByPlaceholderText("OpenRouter"), {
      target: { value: "Anthropic" },
    });
    // Find the password input (value field).
    const passwordInputs = document.querySelectorAll(
      'input[type="password"]',
    );
    fireEvent.change(passwordInputs[0]!, { target: { value: "sk-ant-real" } });

    fireEvent.click(screen.getByRole("button", { name: /Save secret/i }));

    await waitFor(() => {
      expect(putBody).toBeDefined();
    });
    expect(JSON.parse(putBody!)).toMatchObject({
      value: "sk-ant-real",
      label: "Anthropic",
    });
  });
});

describe("VaultInventoryPanel — profiles", () => {
  it("shows profile count badge when entry has profiles", async () => {
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
        ] satisfies VaultEntryMeta[],
      },
    }));

    render(<VaultInventoryPanel />);
    await waitFor(() => {
      const badge = screen.getByTestId("profile-badge-OPENROUTER_API_KEY");
      expect(badge.textContent).toContain("2 profiles");
    });
  });

  it("expands profile panel and renders Enable profiles button when no profiles exist", async () => {
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 200,
      body: {
        entries: [
          {
            key: "OPENROUTER_API_KEY",
            category: "provider",
            label: "OpenRouter",
            hasProfiles: false,
            kind: "secret",
          },
        ] satisfies VaultEntryMeta[],
      },
    }));

    render(<VaultInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Expand/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Expand/i }));

    await waitFor(() => {
      const panel = screen.getByTestId(
        "profiles-panel-OPENROUTER_API_KEY",
      );
      expect(panel).toBeTruthy();
    });

    expect(
      screen.getByRole("button", { name: /Enable profiles/i }),
    ).toBeTruthy();
  });
});

describe("VaultInventoryPanel — routing editor", () => {
  it("loads existing rules and renders them filtered to the current key", async () => {
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
        ] satisfies VaultEntryMeta[],
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
            {
              keyPattern: "ANTHROPIC_API_KEY", // different key — must not show
              scope: { kind: "agent", agentId: "agent-A" },
              profileId: "default",
            },
          ],
        },
      },
    }));
    setRoute("GET", "/api/agents", () => ({
      status: 200,
      body: { agents: [{ id: "agent-A", name: "Agent A" }] },
    }));
    setRoute("GET", "/api/apps", () => ({
      status: 200,
      body: { apps: [] },
    }));

    render(<VaultInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("profile-badge-OPENROUTER_API_KEY")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Expand/i }));

    await waitFor(() => {
      const editor = screen.getByTestId("routing-editor-OPENROUTER_API_KEY");
      expect(editor).toBeTruthy();
      // Only 1 rule (matching this key) should render.
      expect(editor.textContent).toContain("agent-A");
      expect(editor.textContent).toContain("work");
      expect(editor.textContent).not.toContain("ANTHROPIC");
    });
  });

  it("PUTs new rule on save", async () => {
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
        ] satisfies VaultEntryMeta[],
      },
    }));
    setRoute("GET", "/api/secrets/routing", () => ({
      status: 200,
      body: { config: { rules: [] } },
    }));
    setRoute("GET", "/api/agents", () => ({
      status: 200,
      body: { agents: [{ id: "agent-A", name: "Agent A" }] },
    }));
    setRoute("GET", "/api/apps", () => ({ status: 200, body: { apps: [] } }));
    let putBody: string | undefined;
    setRoute("PUT", "/api/secrets/routing", (req) => {
      putBody = req.body;
      return {
        status: 200,
        body: { config: JSON.parse(req.body!).config },
      };
    });

    render(<VaultInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("profile-badge-OPENROUTER_API_KEY")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Expand/i }));
    await waitFor(() => {
      expect(
        screen.getByTestId("routing-editor-OPENROUTER_API_KEY"),
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add routing rule/i }));
    await waitFor(() => {
      expect(
        screen.getByTestId("add-routing-rule-OPENROUTER_API_KEY"),
      ).toBeTruthy();
    });

    // Default scope kind is "agent". Pick agent + profile.
    const selects = screen.getAllByRole("combobox");
    // selects: [scopeKind, agent/app, profile]
    fireEvent.change(selects[1]!, { target: { value: "agent-A" } });
    fireEvent.change(selects[2]!, { target: { value: "work" } });

    fireEvent.click(screen.getByRole("button", { name: /Save rule/i }));

    await waitFor(() => {
      expect(putBody).toBeDefined();
    });
    const parsed = JSON.parse(putBody!) as { config: { rules: RoutingRule[] } };
    expect(parsed.config.rules).toHaveLength(1);
    expect(parsed.config.rules[0]).toMatchObject({
      keyPattern: "OPENROUTER_API_KEY",
      scope: { kind: "agent", agentId: "agent-A" },
      profileId: "work",
    });
  });
});

interface RoutingRule {
  keyPattern: string;
  scope: { kind: string; agentId?: string; appName?: string };
  profileId: string;
}

describe("VaultInventoryPanel — delete flow", () => {
  it("calls DELETE /api/secrets/inventory/:key when confirmed", async () => {
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 200,
      body: {
        entries: [
          {
            key: "EVM_PRIVATE_KEY",
            category: "wallet",
            label: "EVM_PRIVATE_KEY",
            hasProfiles: false,
            kind: "secret",
          },
        ] satisfies VaultEntryMeta[],
      },
    }));
    let deleted = false;
    setRoute("DELETE", "/api/secrets/inventory/EVM_PRIVATE_KEY", () => {
      deleted = true;
      return { status: 200, body: { ok: true } };
    });

    vi.stubGlobal("confirm", () => true);

    render(<VaultInventoryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("vault-category-wallet")).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Delete EVM_PRIVATE_KEY/i }),
    );
    await waitFor(() => {
      expect(deleted).toBe(true);
    });
  });
});
