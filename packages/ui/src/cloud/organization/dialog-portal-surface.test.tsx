/** Portal-theme coverage for the Organization dialogs and their selects. */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, options?: Record<string, unknown>) =>
    (options?.defaultValue as string) ?? key,
}));

import { ContributeCredentialDialog } from "./contribute-credential-dialog";
import { CredentialsList } from "./credentials-list";
import { InviteMemberDialog } from "./invite-member-dialog";
import { MembersList } from "./members-list";
import { PendingInvitesList } from "./pending-invites-list";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

function renderInsideNuphyScope(ui: ReactElement): void {
  const scope = document.createElement("div");
  scope.className = "nuphy-scope";
  document.body.append(scope);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, {
    container: scope,
  });
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.documentElement.classList.remove("dark");
});

describe.each([
  {
    name: "invite member",
    selectName: "Role",
    renderDialog: () => (
      <InviteMemberDialog
        isOpen
        onClose={() => {}}
        onSuccess={() => {}}
        organizationName="IQ Labs"
      />
    ),
  },
  {
    name: "contribute credential",
    selectName: "Provider",
    renderDialog: () => (
      <ContributeCredentialDialog
        isOpen
        onClose={() => {}}
        onSuccess={() => {}}
      />
    ),
  },
])("$name dialog portal surface", ({ renderDialog, selectName }) => {
  it("uses a globally defined opaque surface outside .nuphy-scope", () => {
    document.documentElement.classList.remove("dark");
    renderInsideNuphyScope(renderDialog());

    const dialog = screen.getByRole("dialog");
    expect(dialog.closest(".nuphy-scope")).toBeNull();
    expect(dialog.classList.contains("bg-bg")).toBe(true);
    expect(dialog.classList.contains("bg-popover")).toBe(false);
  });

  it("keeps its portalled select menu on the same global surface", () => {
    renderInsideNuphyScope(renderDialog());

    fireEvent.pointerDown(screen.getByRole("combobox", { name: selectName }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse",
    });
    const listbox = screen.getByRole("listbox");
    expect(listbox.closest(".nuphy-scope")).toBeNull();
    expect(listbox.classList.contains("bg-bg")).toBe(true);
    expect(listbox.classList.contains("bg-popover")).toBe(false);
  });
});

function expectGlobalOpaquePortal(element: HTMLElement): void {
  expect(element.closest(".nuphy-scope")).toBeNull();
  expect(element.classList.contains("bg-bg")).toBe(true);
  expect(element.classList.contains("bg-popover")).toBe(false);
}

describe("Organization row action portal surfaces", () => {
  it("keeps the member role menu and removal dialog globally opaque", () => {
    renderInsideNuphyScope(
      <MembersList
        members={[
          {
            id: "member-1",
            name: "Member One",
            email: "member@example.test",
            wallet_address: null,
            wallet_chain_type: null,
            role: "member",
            is_active: true,
            created_at: "2026-08-23T08:00:00.000Z",
            updated_at: "2026-08-23T08:00:00.000Z",
          },
        ]}
        currentUserId="owner-1"
        currentUserRole="owner"
        isOwner
        onUpdateRole={() => {}}
        onRemove={() => {}}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("combobox"), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse",
    });
    expectGlobalOpaquePortal(screen.getByRole("listbox"));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove Member" }));
    expectGlobalOpaquePortal(screen.getByRole("alertdialog"));
  });

  it("keeps the revoke-invite dialog globally opaque", () => {
    renderInsideNuphyScope(
      <PendingInvitesList
        invites={[
          {
            id: "invite-1",
            email: "invitee@example.test",
            role: "member",
            status: "pending",
            expires_at: "2099-08-24T08:00:00.000Z",
            created_at: "2026-08-23T08:00:00.000Z",
            inviter: {
              id: "owner-1",
              name: "Owner One",
              email: "owner@example.test",
            },
            accepted_at: null,
          },
        ]}
        onRevoke={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Revoke invitation for invitee@example.test",
      }),
    );
    expectGlobalOpaquePortal(screen.getByRole("alertdialog"));
  });

  it("keeps the credential-removal dialog globally opaque", () => {
    renderInsideNuphyScope(
      <CredentialsList
        credentials={[
          {
            id: "credential-1",
            provider: "openai-api",
            label: "OpenAI key",
            last4: "1234",
            enabled: true,
            priority: 0,
            health: "ok",
            healthDetail: null,
            usage: null,
            contributedBy: { id: "owner-1", name: "Owner One" },
            callsToday: 0,
            lastUsedAt: null,
            createdAt: "2026-08-23T08:00:00.000Z",
          },
        ]}
        currentUserId="owner-1"
        canManage
        onToggle={() => {}}
        onRemove={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    expectGlobalOpaquePortal(screen.getByRole("alertdialog"));
  });
});
