// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

import { ContactsTuiView, interact } from "./ContactsAppView";

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
});
