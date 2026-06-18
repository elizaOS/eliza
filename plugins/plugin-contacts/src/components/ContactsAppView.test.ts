// @vitest-environment jsdom
//
// GUI / XR surface tests for ContactsAppView — the componentExport shared by
// the default `gui` view and the `xr` view (both render this same component).
// Renders the real component with a controllable @elizaos/capacitor-contacts
// bridge and asserts populated data + every interactive control's behavior.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const contactsBridge = vi.hoisted(() => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  importVCard: vi.fn(),
}));

const platform = vi.hoisted(() => ({ isNative: true }));

vi.mock("@elizaos/capacitor-contacts", () => ({
  Contacts: contactsBridge,
}));

vi.mock("@elizaos/ui/platform", () => ({
  get isNative() {
    return platform.isNative;
  },
}));

import { ContactsAppView } from "./ContactsAppView";

// Realistic ContactSummary fixtures (shape matches plugin-native-contacts'
// definitions.ts): one starred, one with a photoUri, one email-only (no phone),
// and one with duplicate phone entries to prove dedupePreservingOrder.
const adaPhotoUri = "content://contacts/photo/ada.jpg";
const fixtures = [
  {
    id: "ada",
    lookupKey: "lookup-ada",
    displayName: "Ada Lovelace",
    phoneNumbers: ["+15550100", "+15550100", "+15559999"],
    emailAddresses: ["ada@example.com", "ada@example.com"],
    photoUri: adaPhotoUri,
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

const overlayCtx = () => ({
  exitToApps: vi.fn(),
  // Mirror the host's i18n contract: return the provided defaultValue.
  t: (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  platform.isNative = true;
  contactsBridge.listContacts.mockResolvedValue({ contacts: fixtures });
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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderView(ctx = overlayCtx()) {
  const utils = render(React.createElement(ContactsAppView, ctx));
  await screen.findByText("Ada Lovelace");
  return { ...utils, ctx };
}

describe("ContactsAppView — populated list", () => {
  it("renders every contact with name + phone/email subtitle fallback + starred star + avatar", async () => {
    const { container } = await renderView();

    // All three display names render.
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("Katherine Johnson")).toBeTruthy();

    // Subtitle uses primaryPhone when present, else primaryEmail.
    expect(screen.getByText("+15550100")).toBeTruthy(); // Ada — phone
    expect(screen.getByText("+15550200")).toBeTruthy(); // Grace — phone
    expect(screen.getByText("kj@example.com")).toBeTruthy(); // Katherine — email only

    // Star icon renders only for the starred row (Ada).
    const stars = screen.getAllByLabelText("Starred");
    expect(stars).toHaveLength(1);
    const adaRow = screen.getByText("Ada Lovelace").closest("button");
    expect(adaRow?.contains(stars[0] ?? null)).toBe(true);

    // Avatar: Ada has a photoUri => <img>; the no-photo rows show initials.
    const img = container.querySelector(`img[src="${adaPhotoUri}"]`);
    expect(img).toBeTruthy();
    expect(screen.getByText("GH")).toBeTruthy(); // Grace Hopper initials
    expect(screen.getByText("KJ")).toBeTruthy(); // Katherine Johnson initials
  });
});

describe("ContactsAppView — search", () => {
  it("filters the list to a matching substring and shows the no-matches state otherwise", async () => {
    await renderView();
    const searchBox = screen.getByTestId("contacts-search") as HTMLInputElement;

    fireEvent.change(searchBox, { target: { value: "grace" } });
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(screen.queryByText("Katherine Johnson")).toBeNull();

    fireEvent.change(searchBox, { target: { value: "zzzz-nobody" } });
    expect(screen.getByText("No contacts match your search.")).toBeTruthy();
    expect(screen.queryByText("Grace Hopper")).toBeNull();
  });
});

describe("ContactsAppView — list → detail navigation", () => {
  it("opens the detail panel with tel:/mailto: links, deduped phones, starred badge, and the read-only note", async () => {
    await renderView();

    fireEvent.click(screen.getByText("Ada Lovelace"));

    // Header title swaps to the contact name (rendered as an <h1>); the detail
    // panel also shows the name as an <h2>, so disambiguate by heading level.
    expect(
      screen.getByRole("heading", { level: 1, name: "Ada Lovelace" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Ada Lovelace" }),
    ).toBeTruthy();

    // Phone numbers render as tel: anchors; the duplicate "+15550100" collapses
    // to a single entry (dedupePreservingOrder).
    const telLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.startsWith("tel:"));
    const telHrefs = telLinks.map((a) => a.getAttribute("href"));
    expect(telHrefs).toEqual(["tel:+15550100", "tel:+15559999"]);

    // Email renders as a mailto: anchor (also deduped — two identical entries).
    const mailLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.startsWith("mailto:"));
    expect(mailLinks.map((a) => a.getAttribute("href"))).toEqual([
      "mailto:ada@example.com",
    ]);

    // Starred badge text appears in the detail panel.
    expect(screen.getAllByText("Starred").length).toBeGreaterThanOrEqual(1);

    // Read-only note is shown.
    expect(
      screen.getByText(
        "Editing existing contacts is unavailable on this device.",
      ),
    ).toBeTruthy();
  });

  it("shows the per-group emptyLabel when a contact has no emails", async () => {
    await renderView();

    fireEvent.click(screen.getByText("Grace Hopper")); // phone only, no email
    expect(screen.getByText("No email addresses")).toBeTruthy();
    // The phone it does have renders as a tel: link.
    const tel = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === "tel:+15550200");
    expect(tel).toBeTruthy();
  });
});

describe("ContactsAppView — back button", () => {
  it("returns to the list from detail, and calls exitToApps from the list", async () => {
    const { ctx } = await renderView();

    // In list mode the back button exits the app.
    fireEvent.click(screen.getByLabelText("Back"));
    expect(ctx.exitToApps).toHaveBeenCalledTimes(1);

    // Open a contact, then back returns to the list (not exit).
    fireEvent.click(screen.getByText("Ada Lovelace"));
    expect(
      screen.getByRole("heading", { level: 1, name: "Ada Lovelace" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Back to list"));
    expect(screen.getByRole("heading", { name: "Contacts" })).toBeTruthy();
    expect(ctx.exitToApps).toHaveBeenCalledTimes(1); // unchanged
  });
});

describe("ContactsAppView — refresh", () => {
  it("re-fetches on click and is disabled while loading", async () => {
    const initial = deferred<{ contacts: typeof fixtures }>();
    contactsBridge.listContacts.mockReturnValueOnce(initial.promise);

    render(React.createElement(ContactsAppView, overlayCtx()));

    // While the initial load is pending, the refresh button is disabled.
    const refreshBtn = screen.getByTestId(
      "contacts-refresh",
    ) as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);

    initial.resolve({ contacts: fixtures });
    await screen.findByText("Ada Lovelace");
    expect(refreshBtn.disabled).toBe(false);
    expect(contactsBridge.listContacts).toHaveBeenCalledTimes(1);

    fireEvent.click(refreshBtn);
    await waitFor(() =>
      expect(contactsBridge.listContacts).toHaveBeenCalledTimes(2),
    );
  });
});

describe("ContactsAppView — new contact form", () => {
  it("gates Save on a non-empty name, then creates with trimmed/omitted fields and returns to the list", async () => {
    await renderView();

    fireEvent.click(screen.getByTestId("contacts-new"));
    expect(screen.getByRole("heading", { name: "New contact" })).toBeTruthy();

    const saveBtn = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    const nameInput = screen.getByPlaceholderText(
      "Full name",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "  Katherine Johnson  " } });
    expect(saveBtn.disabled).toBe(false);

    fireEvent.change(screen.getByPlaceholderText("+1 555 123 4567"), {
      target: { value: " +15550400 " },
    });
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: " kj@example.com " },
    });

    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(contactsBridge.createContact).toHaveBeenCalledWith({
        displayName: "Katherine Johnson",
        phoneNumber: "+15550400",
        emailAddress: "kj@example.com",
      }),
    );
    // Returns to the list and re-fetches (initial load + post-create refresh).
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Contacts" })).toBeTruthy(),
    );
    expect(contactsBridge.listContacts).toHaveBeenCalledTimes(2);
  });

  it("omits blank optional fields from the create payload", async () => {
    await renderView();
    fireEvent.click(screen.getByTestId("contacts-new"));
    fireEvent.change(screen.getByPlaceholderText("Full name"), {
      target: { value: "Solo Name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(contactsBridge.createContact).toHaveBeenCalledWith({
        displayName: "Solo Name",
      }),
    );
  });

  it("Cancel returns to the list without creating a contact", async () => {
    await renderView();
    fireEvent.click(screen.getByTestId("contacts-new"));
    fireEvent.change(screen.getByPlaceholderText("Full name"), {
      target: { value: "Discarded" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Contacts" })).toBeTruthy();
    expect(contactsBridge.createContact).not.toHaveBeenCalled();
  });
});

describe("ContactsAppView — vCard import", () => {
  it("reads the picked file and imports it via the bridge, then re-fetches and resets the input", async () => {
    // Empty list => the empty-state ImportVCardButton is shown.
    contactsBridge.listContacts.mockResolvedValue({ contacts: [] });
    const { container } = render(
      React.createElement(ContactsAppView, overlayCtx()),
    );
    await screen.findByText("No contacts yet");
    expect(screen.getByRole("button", { name: "Import vCard" })).toBeTruthy();

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput.accept).toContain(".vcf");

    const vcardText = "BEGIN:VCARD\nFN:Imported Person\nEND:VCARD";
    const file = new File([vcardText], "upload.vcf", { type: "text/vcard" });
    // jsdom's File.prototype.text resolves the contents; assert that explicitly.
    await expect(file.text()).resolves.toBe(vcardText);

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() =>
      expect(contactsBridge.importVCard).toHaveBeenCalledWith({ vcardText }),
    );
    // Refresh runs after import (initial empty load + post-import refresh).
    await waitFor(() =>
      expect(contactsBridge.listContacts).toHaveBeenCalledTimes(2),
    );
    // Input value is reset so the same file can be re-picked.
    expect(fileInput.value).toBe("");
  });
});

describe("ContactsAppView — error + non-native gate", () => {
  it("surfaces a bridge failure in a role=alert", async () => {
    contactsBridge.listContacts.mockRejectedValueOnce(
      new Error("READ_CONTACTS denied"),
    );
    render(React.createElement(ContactsAppView, overlayCtx()));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("READ_CONTACTS denied");
  });

  it("short-circuits to an empty list on non-native platforms without touching the bridge", async () => {
    platform.isNative = false;
    render(React.createElement(ContactsAppView, overlayCtx()));

    await screen.findByText("No contacts yet");
    expect(contactsBridge.listContacts).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ContactsAppView — avatar initials helper", () => {
  it("renders single-word and unnamed fallbacks correctly", async () => {
    contactsBridge.listContacts.mockResolvedValue({
      contacts: [
        {
          id: "mononym",
          lookupKey: "lk-mono",
          displayName: "Cher",
          phoneNumbers: ["+1"],
          emailAddresses: [],
          starred: false,
        },
        {
          id: "blank",
          lookupKey: "lk-blank",
          displayName: "",
          phoneNumbers: [],
          emailAddresses: ["x@y.z"],
          starred: false,
        },
      ],
    });
    render(React.createElement(ContactsAppView, overlayCtx()));
    await screen.findByText("Cher");

    // Single word => first initial.
    expect(screen.getByText("C")).toBeTruthy();
    // Empty name => "Unnamed" label + "?" initial fallback.
    const unnamedRow = screen.getByText("Unnamed").closest("button");
    expect(unnamedRow).toBeTruthy();
    expect(within(unnamedRow as HTMLElement).getByText("?")).toBeTruthy();
  });
});
