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

function renderInsideSettingsShell(ui: ReactElement): void {
  // Stand-in for the cloud settings panel container: portalled dialog and
  // listbox surfaces must escape it and land on the global document body.
  const shell = document.createElement("div");
  shell.dataset.settingsShell = "true";
  document.body.append(shell);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, {
    container: shell,
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
  it("portals the dialog outside the settings shell", () => {
    document.documentElement.classList.remove("dark");
    renderInsideSettingsShell(renderDialog());

    const dialog = screen.getByRole("dialog");
    expect(dialog.closest("[data-settings-shell]")).toBeNull();
  });

  it("portals its select menu outside the settings shell", () => {
    renderInsideSettingsShell(renderDialog());

    fireEvent.pointerDown(screen.getByRole("combobox", { name: selectName }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse",
    });
    const listbox = screen.getByRole("listbox");
    expect(listbox.closest("[data-settings-shell]")).toBeNull();
  });
});

function expectGlobalPortal(element: HTMLElement): void {
  expect(element.closest("[data-settings-shell]")).toBeNull();
}

describe("Organization row action portal surfaces", () => {
  it("portals the member role menu and removal dialog globally", () => {
    renderInsideSettingsShell(
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
    expectGlobalPortal(screen.getByRole("listbox"));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove Member" }));
    expectGlobalPortal(screen.getByRole("alertdialog"));
  });

  it("portals the revoke-invite dialog globally", () => {
    renderInsideSettingsShell(
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
    expectGlobalPortal(screen.getByRole("alertdialog"));
  });

  it("portals the credential-removal dialog globally", () => {
    renderInsideSettingsShell(
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
    expectGlobalPortal(screen.getByRole("alertdialog"));
  });
});
