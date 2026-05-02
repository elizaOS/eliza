// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletKeysSection } from "./WalletKeysSection";

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
  hasProfiles: boolean;
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
  // Strip query string for routing — the wallet section uses
  // `?category=wallet`, but the handler key is the path only.
  const rawPath =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? `${input.pathname}${input.search}`
        : new URL(input.url).pathname;
  const queryIndex = rawPath.indexOf("?");
  const urlPath = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
  const method = (init?.method ?? "GET").toUpperCase();
  const handler = routes.get(`${method} ${urlPath}`);
  if (!handler) {
    throw new Error(`fakeFetch: no handler for ${method} ${urlPath}`);
  }
  const result = handler({
    method,
    body: typeof init?.body === "string" ? init.body : undefined,
    url: rawPath,
  });
  return Promise.resolve(
    new Response(JSON.stringify(result.body), { status: result.status }),
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

describe("WalletKeysSection", () => {
  it("requests the inventory route filtered to wallet category", async () => {
    let captured = "";
    setRoute("GET", "/api/secrets/inventory", (req) => {
      captured = req.url;
      return {
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
      };
    });

    render(<WalletKeysSection />);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-keys-list")).toBeTruthy();
    });
    expect(captured).toContain("category=wallet");
  });

  it("renders empty state when no wallet keys exist", async () => {
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 200,
      body: { entries: [] },
    }));
    render(<WalletKeysSection />);
    await waitFor(() => {
      expect(screen.getByTestId("wallet-keys-empty")).toBeTruthy();
    });
  });

  it("surfaces load failure to the error banner", async () => {
    setRoute("GET", "/api/secrets/inventory", () => ({
      status: 500,
      body: { error: "boom" },
    }));
    render(<WalletKeysSection />);
    await waitFor(() => {
      expect(screen.getByTestId("wallet-keys-error")).toBeTruthy();
    });
  });

  it("reveal button hits the inventory reveal endpoint", async () => {
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
    let revealHits = 0;
    setRoute("GET", "/api/secrets/inventory/EVM_PRIVATE_KEY", () => {
      revealHits += 1;
      return {
        status: 200,
        body: {
          ok: true,
          value: "0x1234567890abcdef1234567890abcdef12345678",
          source: "bare",
        },
      };
    });

    render(<WalletKeysSection />);
    await waitFor(() => {
      expect(screen.getByTestId("wallet-keys-list")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("wallet-keys-reveal-EVM_PRIVATE_KEY"));
    await waitFor(() => {
      expect(revealHits).toBe(1);
    });
  });
});
