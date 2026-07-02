// @vitest-environment jsdom

/**
 * Credentials tab (#11332) — masked rows, RBAC gating, and the contribute
 * modal's happy + probe-fail paths, driven through the real React-Query hooks
 * against a mocked typed api client (the same seam the app uses).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client")>(
      "../lib/api-client",
    );
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});
vi.mock("../shell/CloudI18nProvider", () => ({
  // t() returns defaultValue with {{param}} interpolation so assertions read
  // the real rendered copy.
  useCloudT: () => (key: string, options?: Record<string, unknown>) => {
    let text = (options?.defaultValue as string) ?? key;
    for (const [name, value] of Object.entries(options ?? {})) {
      if (name === "defaultValue") continue;
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
    return text;
  },
}));
vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { ApiError } from "../lib/api-client";
import { CredentialsTab } from "./credentials-tab";
import type {
  PooledCredentialDto,
  UserWithOrganizationDto,
} from "./data/cloud-org-types";

const organization = {
  id: "org-1",
  name: "IQ Labs",
  slug: "iq-labs",
  credit_balance: "10.00",
  billing_email: null,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const owner: UserWithOrganizationDto = {
  id: "u-owner",
  email: "owner@iq.dev",
  name: "Shaw",
  wallet_address: null,
  wallet_chain_type: null,
  organization_id: "org-1",
  role: "owner",
  organization,
};

const member: UserWithOrganizationDto = {
  ...owner,
  id: "u-member",
  email: "member@iq.dev",
  name: "Nubs",
  role: "member",
};

const credentials: PooledCredentialDto[] = [
  {
    id: "cred-1",
    provider: "anthropic-api",
    label: "shaw console key",
    last4: "abcd",
    enabled: true,
    priority: 100,
    health: "ok",
    healthDetail: null,
    usage: null,
    contributedBy: { id: "u-owner", name: "Shaw" },
    callsToday: 42,
    lastUsedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "cred-2",
    provider: "openai-api",
    label: "nubs personal key",
    last4: "9xyz",
    enabled: true,
    priority: 100,
    health: "rate-limited",
    // epoch ms, exactly as the backend serializes LinkedAccountHealthDetail.
    healthDetail: { until: Date.parse("2026-07-02T18:00:00.000Z") },
    usage: null,
    contributedBy: { id: "u-member", name: "Nubs" },
    callsToday: 3,
    lastUsedAt: "2026-07-01T12:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
  },
];

function mockListOnly() {
  apiMock.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === "/api/organizations/credentials" && !opts?.method) {
      return Promise.resolve({ success: true, data: credentials });
    }
    return Promise.reject(new Error(`unexpected call: ${path}`));
  });
}

function renderTab(user: UserWithOrganizationDto, autoContribute = false) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CredentialsTab user={user} autoContribute={autoContribute} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("CredentialsTab — masked rows", () => {
  it("renders label, provider badge, masked last4, health, calls, contributor", async () => {
    mockListOnly();
    renderTab(owner);

    expect(await screen.findByText("shaw console key")).toBeTruthy();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("••••abcd")).toBeTruthy();
    expect(screen.getByText("42 calls today")).toBeTruthy();
    // Contributor, with the own-key "(you)" marker for the current user.
    expect(screen.getByText(/Shaw \(you\)/)).toBeTruthy();
    expect(screen.getByText(/Nubs/)).toBeTruthy();
    expect(
      screen.getByTestId("health-dot-cred-1").getAttribute("data-health"),
    ).toBe("ok");

    // Rate-limited row surfaces the recovery time from healthDetail.until.
    expect(
      screen.getByTestId("health-dot-cred-2").getAttribute("data-health"),
    ).toBe("rate-limited");
    expect(screen.getByText(/Rate-limited until/)).toBeTruthy();

    // Never any key material beyond last4.
    expect(screen.queryByText(/sk-/)).toBeNull();
  });
});

describe("CredentialsTab — RBAC", () => {
  it("hides enable toggles + others' delete for a plain member, keeps own delete", async () => {
    mockListOnly();
    renderTab(member);

    await screen.findByText("shaw console key");

    // No enable/disable toggles for members.
    expect(screen.queryByLabelText(/Toggle /)).toBeNull();
    // No "Invite & Connect" (owner/admin invite surface).
    expect(screen.queryByText("Invite & Connect")).toBeNull();
    // Cannot delete someone else's credential…
    expect(screen.queryByLabelText("Remove shaw console key")).toBeNull();
    // …but can delete their own contribution.
    expect(screen.getByLabelText("Remove nubs personal key")).toBeTruthy();
    // Contribute is open to every member.
    expect(screen.getByText("Contribute Key")).toBeTruthy();
  });

  it("shows toggles + delete on every row for an owner, PATCHes on toggle", async () => {
    mockListOnly();
    apiMock.mockImplementation(
      (path: string, opts?: { method?: string; json?: unknown }) => {
        if (path === "/api/organizations/credentials" && !opts?.method) {
          return Promise.resolve({ success: true, data: credentials });
        }
        if (
          path === "/api/organizations/credentials/cred-1" &&
          opts?.method === "PATCH"
        ) {
          return Promise.resolve({
            success: true,
            data: { ...credentials[0], enabled: false },
          });
        }
        return Promise.reject(new Error(`unexpected call: ${path}`));
      },
    );
    renderTab(owner);

    await screen.findByText("shaw console key");
    expect(screen.getByLabelText("Toggle shaw console key")).toBeTruthy();
    expect(screen.getByLabelText("Toggle nubs personal key")).toBeTruthy();
    expect(screen.getByLabelText("Remove shaw console key")).toBeTruthy();
    expect(screen.getByLabelText("Remove nubs personal key")).toBeTruthy();
    expect(screen.getByText("Invite & Connect")).toBeTruthy();

    await userEvent.click(screen.getByLabelText("Toggle shaw console key"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/organizations/credentials/cred-1",
        expect.objectContaining({
          method: "PATCH",
          json: { enabled: false },
        }),
      ),
    );
  });

  it("DELETEs after confirm", async () => {
    apiMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === "/api/organizations/credentials" && !opts?.method) {
        return Promise.resolve({ success: true, data: credentials });
      }
      if (
        path === "/api/organizations/credentials/cred-2" &&
        opts?.method === "DELETE"
      ) {
        return Promise.resolve({ success: true, message: "removed" });
      }
      return Promise.reject(new Error(`unexpected call: ${path}`));
    });
    renderTab(owner);

    await screen.findByText("nubs personal key");
    await userEvent.click(screen.getByLabelText("Remove nubs personal key"));
    // AlertDialog confirm step.
    await userEvent.click(await screen.findByText("Remove"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/organizations/credentials/cred-2",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});

describe("CredentialsTab — contribute modal", () => {
  it("happy path: POSTs the key and confirms with the MASKED last4 only", async () => {
    apiMock.mockImplementation(
      (path: string, opts?: { method?: string; json?: unknown }) => {
        if (path === "/api/organizations/credentials" && !opts?.method) {
          return Promise.resolve({ success: true, data: [] });
        }
        if (
          path === "/api/organizations/credentials" &&
          opts?.method === "POST"
        ) {
          return Promise.resolve({
            success: true,
            data: { ...credentials[0], last4: "zzzz" },
            message: "ok",
          });
        }
        return Promise.reject(new Error(`unexpected call: ${path}`));
      },
    );
    renderTab(member);

    await userEvent.click(await screen.findByText("Contribute Key"));
    await screen.findByText("Contribute an API Key");

    await userEvent.type(
      screen.getByLabelText("API Key"),
      "sk-live-key-ending-zzzz",
    );
    await userEvent.click(screen.getByText("Validate & Add"));

    // Confirmation step: masked last4 only — the plaintext key is never
    // rendered again after the (password-masked) input.
    expect(await screen.findByText("Key Added to the Pool")).toBeTruthy();
    expect(screen.getByText(/Listed in the pool as ••••zzzz/)).toBeTruthy();
    expect(screen.queryByText("sk-live-key-ending-zzzz")).toBeNull();

    expect(apiMock).toHaveBeenCalledWith(
      "/api/organizations/credentials",
      expect.objectContaining({
        method: "POST",
        json: {
          provider: "anthropic-api",
          apiKey: "sk-live-key-ending-zzzz",
        },
      }),
    );
  });

  it("probe failure: surfaces the live-validation error inline and stays on the form", async () => {
    apiMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === "/api/organizations/credentials" && !opts?.method) {
        return Promise.resolve({ success: true, data: [] });
      }
      if (
        path === "/api/organizations/credentials" &&
        opts?.method === "POST"
      ) {
        return Promise.reject(
          new ApiError(
            400,
            "HTTP_400",
            "Key failed live validation against anthropic-api (status 401). Not added.",
          ),
        );
      }
      return Promise.reject(new Error(`unexpected call: ${path}`));
    });
    renderTab(member);

    await userEvent.click(await screen.findByText("Contribute Key"));
    await screen.findByText("Contribute an API Key");

    await userEvent.type(screen.getByLabelText("API Key"), "sk-revoked-key");
    await userEvent.click(screen.getByText("Validate & Add"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Key failed live validation against anthropic-api (status 401)",
    );
    // Still on the form (no reveal step) so the user can correct the key.
    expect(screen.queryByText("Key Added to the Pool")).toBeNull();
    expect(screen.getByLabelText("API Key")).toBeTruthy();
  });
});
