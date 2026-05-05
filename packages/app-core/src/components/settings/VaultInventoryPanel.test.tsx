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
type RouteHandler = (req: {
  method: string;
  body?: string;
  url: string;
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
  // Match by exact pathname, then by leading prefix that maps to a parametrized route.
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
      expect(
        screen.getByRole("button", { name: /Reveal OpenRouter/i }),
      ).toBeTruthy();
    });

    const revealBtn = screen.getByRole("button", {
      name: /Reveal OpenRouter/i,
    });
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
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    const passwordInput = passwordInputs[0];
    if (!passwordInput) {
      throw new Error("Expected a password input for the secret value");
    }
    fireEvent.change(passwordInput, { target: { value: "sk-ant-real" } });

    fireEvent.click(screen.getByRole("button", { name: /Save secret/i }));

    await waitFor(() => {
      expect(putBody).toBeDefined();
    });
    if (!putBody) {
      throw new Error("Expected PUT body to be captured");
    }
    expect(JSON.parse(putBody)).toMatchObject({
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
      const panel = screen.getByTestId("profiles-panel-OPENROUTER_API_KEY");
      expect(panel).toBeTruthy();
    });

    expect(
      screen.getByRole("button", { name: /Enable profiles/i }),
    ).toBeTruthy();
  });
});

describe("VaultInventoryPanel — cross-tab routing jump", () => {
  it("invokes onJumpToRouting with the row key when the affordance is clicked", async () => {
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

    const onJumpToRouting = vi.fn();
    render(<VaultInventoryPanel onJumpToRouting={onJumpToRouting} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("profile-badge-OPENROUTER_API_KEY"),
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Expand/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Routing rules for OpenRouter/i }),
      ).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Routing rules for OpenRouter/i }),
    );
    expect(onJumpToRouting).toHaveBeenCalledWith("OPENROUTER_API_KEY");
  });

  it("auto-expands the focusKey row on mount", async () => {
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
            profiles: [{ id: "default", label: "Default" }],
            kind: "secret",
          },
        ] satisfies VaultEntryMeta[],
      },
    }));

    const onFocusApplied = vi.fn();
    render(
      <VaultInventoryPanel
        focusKey="OPENROUTER_API_KEY"
        focusProfileId="default"
        onFocusApplied={onFocusApplied}
      />,
    );

    // The focused row's profile panel should mount automatically.
    await waitFor(() => {
      expect(
        screen.getByTestId("profiles-panel-OPENROUTER_API_KEY"),
      ).toBeTruthy();
    });
    await waitFor(() => {
      expect(onFocusApplied).toHaveBeenCalled();
    });
  });
});

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
