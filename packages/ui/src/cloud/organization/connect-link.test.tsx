// @vitest-environment jsdom

/**
 * Connect-link UX (#11332 design §5):
 * - the invite dialog surfaces a copyable accept link built from the one-time
 *   invite token, carrying `connect=1` when opened with connect intent (and
 *   never any key material);
 * - `?tab=credentials&contribute=1` (the connect-link landing) selects the
 *   Credentials tab and opens the contribute modal.
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
  useCloudT: () => (key: string, options?: Record<string, unknown>) => {
    let text = (options?.defaultValue as string) ?? key;
    for (const [name, value] of Object.entries(options ?? {})) {
      if (name === "defaultValue") continue;
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
    return text;
  },
}));
const copyMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: (...args: unknown[]) => copyMock(...args),
}));

import type { UserWithOrganizationDto } from "./data/cloud-org-types";
import { buildInviteLink, InviteMemberDialog } from "./invite-member-dialog";
import { OrganizationTab } from "./organization-tab";

function withClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function mockInviteCreate() {
  apiMock.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === "/api/organizations/invites" && opts?.method === "POST") {
      return Promise.resolve({
        success: true,
        data: {
          id: "inv-1",
          email: "teammate@iq.dev",
          role: "member",
          expires_at: "2026-07-09T00:00:00.000Z",
          status: "pending",
          token: "tok_abc123",
        },
        message: "Invitation sent successfully",
      });
    }
    return Promise.reject(new Error(`unexpected call: ${path}`));
  });
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  copyMock.mockClear();
  window.history.replaceState(null, "", "/");
});

describe("buildInviteLink", () => {
  it("carries only the hashed-token param, plus connect=1 on connect intent", () => {
    expect(buildInviteLink("tok_abc123", false)).toBe(
      "http://localhost/invite/accept?token=tok_abc123",
    );
    expect(buildInviteLink("tok_abc123", true)).toBe(
      "http://localhost/invite/accept?token=tok_abc123&connect=1",
    );
  });
});

describe("InviteMemberDialog — copyable connect link", () => {
  it("shows the copyable connect=1 link after creating an invite", async () => {
    mockInviteCreate();
    const onSuccess = vi.fn();
    withClient(
      <InviteMemberDialog
        isOpen
        onClose={() => {}}
        onSuccess={onSuccess}
        organizationName="IQ Labs"
        connectIntent
      />,
    );

    await userEvent.type(
      screen.getByLabelText("Email Address"),
      "teammate@iq.dev",
    );
    await userEvent.click(screen.getByText("Send Invitation"));

    expect(await screen.findByText("Invitation Created")).toBeTruthy();
    const link = screen.getByText(
      "http://localhost/invite/accept?token=tok_abc123&connect=1",
    );
    expect(link).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByLabelText("Copy invite link"));
    await waitFor(() =>
      expect(copyMock).toHaveBeenCalledWith(
        "http://localhost/invite/accept?token=tok_abc123&connect=1",
      ),
    );
  });

  it("omits connect=1 without connect intent", async () => {
    mockInviteCreate();
    withClient(
      <InviteMemberDialog
        isOpen
        onClose={() => {}}
        onSuccess={() => {}}
        organizationName="IQ Labs"
      />,
    );

    await userEvent.type(
      screen.getByLabelText("Email Address"),
      "teammate@iq.dev",
    );
    await userEvent.click(screen.getByText("Send Invitation"));

    expect(
      await screen.findByText(
        "http://localhost/invite/accept?token=tok_abc123",
      ),
    ).toBeTruthy();
  });
});

describe("OrganizationTab — connect-link landing intent", () => {
  const user: UserWithOrganizationDto = {
    id: "u-member",
    email: "member@iq.dev",
    name: "Nubs",
    wallet_address: null,
    wallet_chain_type: null,
    organization_id: "org-1",
    role: "member",
    organization: {
      id: "org-1",
      name: "IQ Labs",
      slug: "iq-labs",
      credit_balance: "10.00",
      billing_email: null,
      is_active: true,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  };

  it("?tab=credentials&contribute=1 selects the tab and opens the modal", async () => {
    apiMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === "/api/organizations/credentials" && !opts?.method) {
        return Promise.resolve({ success: true, data: [] });
      }
      return Promise.reject(new Error(`unexpected call: ${path}`));
    });
    window.history.replaceState(
      null,
      "",
      "/dashboard/organization?tab=credentials&contribute=1",
    );

    withClient(<OrganizationTab user={user} />);

    // Credentials tab content is active…
    expect(await screen.findByText("Team Credential Pool")).toBeTruthy();
    // …with the contribute modal already open.
    expect(await screen.findByText("Contribute an API Key")).toBeTruthy();
  });

  it("defaults to the Members tab without the intent", async () => {
    apiMock.mockImplementation(() =>
      Promise.resolve({ success: true, data: [] }),
    );
    withClient(<OrganizationTab user={user} />);

    expect(await screen.findByText("Team Members")).toBeTruthy();
    expect(screen.queryByText("Contribute an API Key")).toBeNull();
  });
});
