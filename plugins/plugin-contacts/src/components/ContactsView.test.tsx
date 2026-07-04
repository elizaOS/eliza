// @vitest-environment jsdom

// Drives the unified ContactsView (the single GUI/XR data wrapper) through the
// rendered DOM: the same component the bundle exports for both the "gui" and
// "xr" modalities. Asserts the populated address-book list, the clickable
// contact rows, list -> detail navigation, the per-phone Call / Text handoffs
// to the Phone / Messages views, the search filter, the new-contact form
// (create through the native bridge), the refresh control, and the error /
// permission path — functional parity with the retired ContactsTuiView surface.

import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

configure({ asyncUtilTimeout: 5000 });

const contactsBridge = vi.hoisted(() => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  importVCard: vi.fn(),
  checkPermissions: vi.fn(async () => ({ contacts: "granted" })),
  requestPermissions: vi.fn(async () => ({ contacts: "granted" })),
}));

const platform = vi.hoisted(() => ({ isNative: true }));

vi.mock("@elizaos/capacitor-contacts", () => ({ Contacts: contactsBridge }));

vi.mock("@elizaos/ui/platform", () => ({
  get isNative() {
    return platform.isNative;
  },
}));

import { ContactsView } from "./ContactsView";

const fixtures = [
  {
    id: "ada",
    lookupKey: "lookup-ada",
    displayName: "Ada Lovelace",
    phoneNumbers: ["+15550100", "+15550100", "+15559999"],
    emailAddresses: ["ada@example.com"],
    starred: true,
  },
  {
    id: "grace",
    lookupKey: "lookup-grace",
    displayName: "Grace Hopper",
    phoneNumbers: ["+15550200"],
    emailAddresses: [],
    starred: false,
  },
  {
    id: "katherine",
    lookupKey: "lookup-katherine",
    displayName: "Katherine Johnson",
    phoneNumbers: [],
    emailAddresses: ["kj@example.com"],
    starred: false,
  },
];

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

beforeEach(() => {
  platform.isNative = true;
  contactsBridge.listContacts.mockResolvedValue({ contacts: fixtures });
  contactsBridge.createContact.mockResolvedValue({ id: "new-contact" });
  contactsBridge.importVCard.mockResolvedValue({ imported: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ContactsView — populated list", () => {
  it("loads the address book on mount and renders every contact name", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Ada Lovelace");
    expect(contactsBridge.listContacts).toHaveBeenCalledWith({});
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("Katherine Johnson")).toBeTruthy();
  });

  it("short-circuits to an empty list on non-native platforms without touching the bridge", async () => {
    platform.isNative = false;
    render(React.createElement(ContactsView));
    await waitFor(() => expect(screen.getByText("None")).toBeTruthy());
    expect(contactsBridge.listContacts).not.toHaveBeenCalled();
  });
});

describe("ContactsView — list -> detail", () => {
  it("opens a contact's detail with deduped phones and per-phone Call/Text controls", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Ada Lovelace");

    fireEvent.click(agent("select:ada"));

    // Detail shows the deduped phone numbers (the duplicate +15550100 collapses).
    await waitFor(() => expect(agent("call:+15550100")).toBeTruthy());
    expect(agent("call:+15559999")).toBeTruthy();
    expect(agent("text:+15550100")).toBeTruthy();
  });

  it("Call navigates to the Phone view via the navigation bus, pre-seeding the number", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Grace Hopper");
    fireEvent.click(agent("select:grace"));
    await waitFor(() => expect(agent("call:+15550200")).toBeTruthy());

    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("eliza:navigate:view", listener);
    try {
      fireEvent.click(agent("call:+15550200"));
    } finally {
      window.removeEventListener("eliza:navigate:view", listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      viewId: "phone",
      viewPath: "/phone",
      payload: { number: "+15550200" },
    });
  });

  it("Text navigates to the Messages view via the navigation bus", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Grace Hopper");
    fireEvent.click(agent("select:grace"));
    await waitFor(() => expect(agent("text:+15550200")).toBeTruthy());

    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("eliza:navigate:view", listener);
    try {
      fireEvent.click(agent("text:+15550200"));
    } finally {
      window.removeEventListener("eliza:navigate:view", listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      viewId: "messages",
      viewPath: "/messages",
      payload: { recipient: "+15550200" },
    });
  });

  it("Back returns from detail to the list", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Ada Lovelace");
    fireEvent.click(agent("select:ada"));
    await waitFor(() => expect(agent("call:+15559999")).toBeTruthy());
    fireEvent.click(agent("back"));
    await waitFor(() => expect(agent("new")).toBeTruthy()); // list controls back
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
  });
});

describe("ContactsView — search", () => {
  it("filters the rendered list client-side as the search field changes", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Ada Lovelace");

    const search = agent("search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "grace" } });

    await waitFor(() => expect(screen.queryByText("Ada Lovelace")).toBeNull());
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
  });
});

describe("ContactsView — new contact form", () => {
  it("gates Save on a name, creates with trimmed/omitted fields, and returns to the list", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Ada Lovelace");

    fireEvent.click(agent("new"));
    await waitFor(() => expect(agent("name")).toBeTruthy());

    // Save is gated while the name is empty.
    expect((agent("save") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(agent("name") as HTMLInputElement, {
      target: { value: "Katherine Johnson" },
    });
    fireEvent.change(agent("phone") as HTMLInputElement, {
      target: { value: "+15550400" },
    });
    fireEvent.change(agent("email") as HTMLInputElement, {
      target: { value: "kj@example.com" },
    });

    await waitFor(() =>
      expect((agent("save") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(agent("save"));

    await waitFor(() =>
      expect(contactsBridge.createContact).toHaveBeenCalledWith({
        displayName: "Katherine Johnson",
        phoneNumber: "+15550400",
        emailAddress: "kj@example.com",
      }),
    );
    // Re-fetches after a successful create (initial load + post-create refresh).
    await waitFor(() =>
      expect(contactsBridge.listContacts).toHaveBeenCalledTimes(2),
    );
  });

  it("omits blank optional fields from the create payload", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Ada Lovelace");
    fireEvent.click(agent("new"));
    await waitFor(() => expect(agent("name")).toBeTruthy());
    fireEvent.change(agent("name") as HTMLInputElement, {
      target: { value: "Solo Name" },
    });
    await waitFor(() =>
      expect((agent("save") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(agent("save"));
    await waitFor(() =>
      expect(contactsBridge.createContact).toHaveBeenCalledWith({
        displayName: "Solo Name",
      }),
    );
  });

  it("Cancel returns to the list without creating a contact", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Ada Lovelace");
    fireEvent.click(agent("new"));
    await waitFor(() => expect(agent("name")).toBeTruthy());
    fireEvent.change(agent("name") as HTMLInputElement, {
      target: { value: "Discarded" },
    });
    fireEvent.click(agent("cancel"));
    await waitFor(() => expect(agent("new")).toBeTruthy());
    expect(contactsBridge.createContact).not.toHaveBeenCalled();
  });
});

describe("ContactsView — refresh + error path", () => {
  it("the Refresh control re-fetches the address book", async () => {
    render(React.createElement(ContactsView));
    await screen.findByText("Ada Lovelace");
    expect(contactsBridge.listContacts).toHaveBeenCalledTimes(1);
    fireEvent.click(agent("refresh"));
    await waitFor(() =>
      expect(contactsBridge.listContacts).toHaveBeenCalledTimes(2),
    );
  });

  it("surfaces a bridge failure as the error text", async () => {
    contactsBridge.listContacts.mockRejectedValueOnce(
      new Error("READ_CONTACTS denied"),
    );
    render(React.createElement(ContactsView));
    await screen.findByText("READ_CONTACTS denied");
  });

  it("surfaces a denied permission status as a guidance message", async () => {
    contactsBridge.requestPermissions.mockResolvedValueOnce({
      contacts: "denied",
    });
    render(React.createElement(ContactsView));
    await screen.findByText(/Contacts access is needed/);
    expect(contactsBridge.listContacts).not.toHaveBeenCalled();
  });
});
