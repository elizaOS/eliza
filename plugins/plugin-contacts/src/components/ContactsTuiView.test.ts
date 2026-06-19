// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import fc from "fast-check";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const contactsBridge = vi.hoisted(() => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  importVCard: vi.fn(),
}));

vi.mock("@elizaos/capacitor-contacts", () => ({
  Contacts: contactsBridge,
}));

vi.mock("@elizaos/ui/platform", () => ({
  isNative: true,
}));

import { ContactsTuiView } from "./ContactsAppView";
import { interact } from "./ContactsAppView.interact";

const sampleContacts = [
  {
    id: "ada",
    lookupKey: "lookup-ada",
    displayName: "Ada Lovelace",
    phoneNumbers: ["+15550100"],
    emailAddresses: ["ada@example.com"],
    starred: true,
  },
  {
    id: "grace",
    lookupKey: "lookup-grace",
    displayName: "Grace Hopper",
    phoneNumbers: ["+15550200"],
    emailAddresses: ["grace@example.com"],
    starred: false,
  },
];

function mockBridge() {
  contactsBridge.listContacts.mockResolvedValue({ contacts: sampleContacts });
  contactsBridge.createContact.mockResolvedValue({ id: "new-contact" });
  contactsBridge.importVCard.mockResolvedValue({
    imported: [
      {
        id: "imported-1",
        lookupKey: "lookup-imported",
        displayName: "Imported Person",
        phoneNumbers: ["+15550300"],
        emailAddresses: [],
        starred: false,
        sourceName: "upload.vcf",
      },
    ],
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ContactsTuiView", () => {
  it("mounts contacts, exposes current TUI state, and creates a contact", async () => {
    mockBridge();

    const { container } = render(React.createElement(ContactsTuiView));

    await screen.findByText("Ada Lovelace");
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(contactsBridge.listContacts).toHaveBeenCalledWith({});

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "contacts",
      contactCount: 2,
      query: "",
      loading: false,
    });

    fireEvent.click(screen.getByText("Ada Lovelace"));
    expect(screen.getByText("ada@example.com")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "name" }), {
      target: { value: "Katherine Johnson" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "phone" }), {
      target: { value: "+15550400" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "email" }), {
      target: { value: "kj@example.com" },
    });
    fireEvent.click(screen.getByText("create"));

    await waitFor(() =>
      expect(contactsBridge.createContact).toHaveBeenCalledWith({
        displayName: "Katherine Johnson",
        phoneNumber: "+15550400",
        emailAddress: "kj@example.com",
      }),
    );
  });

  it("renders the populated terminal list, a starred glyph, and selecting a row shows its detail", async () => {
    mockBridge();

    const { container } = render(React.createElement(ContactsTuiView));
    await screen.findByText("Ada Lovelace");

    // Status line reflects the loaded count.
    expect(screen.getByText("2 contacts | refresh")).toBeTruthy();

    // The starred row exposes a behavioral aria-label/title (not a "*"/"-"
    // string) — this is the visual-copy guarantee, enforced by behavior.
    expect(screen.getByLabelText("Starred")).toBeTruthy();
    expect(screen.getByLabelText("Not starred")).toBeTruthy();
    expect(
      container.querySelector('[role="img"][title="Starred"]'),
    ).toBeTruthy();

    // Selecting a row opens its detail (id + deduped tel/mail + starred).
    fireEvent.click(screen.getByText("Ada Lovelace"));
    const detail = screen.getByLabelText(
      "Contacts detail and create",
    ) as HTMLElement;
    expect(within(detail).getByText("ada")).toBeTruthy(); // id value
    expect(within(detail).getByText("+15550100")).toBeTruthy(); // tel
    expect(within(detail).getByText("ada@example.com")).toBeTruthy(); // mail
    expect(within(detail).getByText("starred")).toBeTruthy();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      selectedId: "ada",
      selectedName: "Ada Lovelace",
      lastAction: "open ada",
    });
  });

  it("search filters the list via loadContactsState and records lastAction", async () => {
    mockBridge();
    // First load returns both; the post-search reload returns only Ada.
    contactsBridge.listContacts.mockResolvedValueOnce({
      contacts: sampleContacts,
    });
    contactsBridge.listContacts.mockResolvedValue({
      contacts: [sampleContacts[0]],
    });

    const { container } = render(React.createElement(ContactsTuiView));
    await screen.findByText("Grace Hopper");

    fireEvent.change(screen.getByRole("textbox", { name: "search" }), {
      target: { value: "ada" },
    });

    await waitFor(() => expect(screen.queryByText("Grace Hopper")).toBeNull());
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    // The query is forwarded to the native bridge.
    expect(contactsBridge.listContacts).toHaveBeenCalledWith({ query: "ada" });

    await waitFor(() => {
      const state = JSON.parse(
        container
          .querySelector("[data-view-state]")
          ?.getAttribute("data-view-state") ?? "{}",
      );
      expect(state.query).toBe("ada");
      expect(state.lastAction).toBe("search ada");
    });
  });

  it("imports pasted vCard text, clears the textarea, and records the imported count", async () => {
    mockBridge();

    const { container } = render(React.createElement(ContactsTuiView));
    await screen.findByText("Ada Lovelace");

    const importBtn = screen.getByText("import-vcard") as HTMLButtonElement;
    // Disabled until the textarea has content.
    expect(importBtn.disabled).toBe(true);

    const vcardArea = screen.getByRole("textbox", {
      name: "vcard",
    }) as HTMLTextAreaElement;
    fireEvent.change(vcardArea, {
      target: { value: "BEGIN:VCARD\nFN:Imported Person\nEND:VCARD" },
    });
    expect(importBtn.disabled).toBe(false);

    fireEvent.click(importBtn);

    await waitFor(() =>
      expect(contactsBridge.importVCard).toHaveBeenCalledWith({
        vcardText: "BEGIN:VCARD\nFN:Imported Person\nEND:VCARD",
      }),
    );
    // Textarea is cleared after a successful import.
    await waitFor(() => expect(vcardArea.value).toBe(""));
    // The list is re-fetched after import (initial load + post-import refresh).
    expect(contactsBridge.listContacts).toHaveBeenCalledTimes(2);
    // The view returns to a non-submitting, settled state with the textarea
    // emptied in the JSON snapshot. (lastAction settles on the trailing
    // refresh, since importVCard awaits refresh() after recording the count.)
    await waitFor(() => {
      const state = JSON.parse(
        container
          .querySelector("[data-view-state]")
          ?.getAttribute("data-view-state") ?? "{}",
      );
      expect(state.pendingVCardLength).toBe(0);
      expect(state.submitting).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  it("refresh button re-fetches and create is gated until a name is typed", async () => {
    mockBridge();

    render(React.createElement(ContactsTuiView));
    await screen.findByText("Ada Lovelace");
    expect(contactsBridge.listContacts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("refresh"));
    await waitFor(() =>
      expect(contactsBridge.listContacts).toHaveBeenCalledTimes(2),
    );

    // Create button is disabled with an empty name, enabled once a name exists.
    const createBtn = screen.getByText("create") as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "name" }), {
      target: { value: "Katherine Johnson" },
    });
    expect(createBtn.disabled).toBe(false);
  });

  it("supports terminal capabilities for list, create, and vcard import", async () => {
    mockBridge();

    await expect(
      interact("terminal-list-contacts", { query: "ada", limit: 10 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      query: "ada",
      count: 1,
      contacts: [
        {
          id: "ada",
          lookupKey: "lookup-ada",
          displayName: "Ada Lovelace",
          phoneNumbers: ["+15550100"],
          emailAddresses: ["ada@example.com"],
          starred: true,
        },
      ],
    });
    expect(contactsBridge.listContacts).toHaveBeenCalledWith({
      query: "ada",
      limit: 10,
    });

    await expect(
      interact("terminal-create-contact", {
        displayName: "Katherine Johnson",
        phoneNumber: "+15550400",
        emailAddress: "kj@example.com",
      }),
    ).resolves.toEqual({
      created: true,
      id: "new-contact",
      viewType: "tui",
    });

    await expect(
      interact("terminal-import-vcard", {
        vcardText: "BEGIN:VCARD\nFN:Imported Person\nEND:VCARD",
      }),
    ).resolves.toMatchObject({
      imported: 1,
      viewType: "tui",
      contacts: [
        {
          id: "imported-1",
          sourceName: "upload.vcf",
        },
      ],
    });
  });

  it("clamps hostile terminal-list-contacts limits before hitting the native bridge", async () => {
    mockBridge();

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.double({ noNaN: true }),
          fc.constant(Number.POSITIVE_INFINITY),
          fc.constant(Number.NEGATIVE_INFINITY),
          fc.constant(Number.NaN),
        ),
        async (limit) => {
          contactsBridge.listContacts.mockClear();
          await interact("terminal-list-contacts", { limit });

          const requested = contactsBridge.listContacts.mock.calls[0]?.[0] as
            | { limit?: number }
            | undefined;
          expect(Number.isInteger(requested?.limit)).toBe(true);
          expect(requested?.limit).toBeGreaterThanOrEqual(1);
          expect(requested?.limit).toBeLessThanOrEqual(500);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects malformed terminal create/import payloads without native writes", async () => {
    mockBridge();

    await expect(
      interact("terminal-create-contact", {
        displayName: " \t\n ",
        phoneNumber: "+15550400",
      }),
    ).rejects.toThrow("displayName is required");
    await expect(
      interact("terminal-create-contact", {
        displayName: ["Ada Lovelace"] as unknown as string,
      }),
    ).rejects.toThrow("displayName is required");
    await expect(
      interact("terminal-import-vcard", { vcardText: "" }),
    ).rejects.toThrow("vcardText is required");
    await expect(
      interact("terminal-import-vcard", {
        vcardText: { text: "BEGIN:VCARD" } as unknown as string,
      }),
    ).rejects.toThrow("vcardText is required");

    expect(contactsBridge.createContact).not.toHaveBeenCalled();
    expect(contactsBridge.importVCard).not.toHaveBeenCalled();
  });
});
