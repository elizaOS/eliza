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
  checkPermissions: vi.fn(async () => ({ contacts: "granted" })),
  requestPermissions: vi.fn(async () => ({ contacts: "granted" })),
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

// Under fake timers, the initial load chains several microtasks
// (requestPermissions → listContacts → setState). advanceTimersByTimeAsync(0)
// flushes one microtask checkpoint; loop it to drain the whole chain.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
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

describe("ContactsAppView — search moved to chat", () => {
  it("renders no in-view search box, just a chat-search hint, and shows the full list", async () => {
    await renderView();

    // The inline search input is gone — search now happens in the floating chat.
    expect(screen.queryByTestId("contacts-search")).toBeNull();
    expect(screen.getByTestId("contacts-search-hint").textContent).toContain(
      "by typing in the chat",
    );

    // The full list renders unfiltered.
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("Katherine Johnson")).toBeTruthy();
  });
});

describe("ContactsAppView — list → detail navigation", () => {
  it("opens the detail panel with in-app Call/Text controls, mailto: email, deduped phones, starred badge, and the read-only note", async () => {
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

    // Phone numbers render as number text plus in-app "Call" and "Text"
    // controls rather than a tel: OS handoff. The duplicate "+15550100"
    // collapses to a single entry (dedupePreservingOrder), so two phone rows →
    // two Call + two Text controls.
    expect(screen.queryByRole("link", { name: /tel:/ })).toBeNull();
    expect(screen.getByText("+15550100")).toBeTruthy();
    expect(screen.getByText("+15559999")).toBeTruthy();
    expect(screen.getAllByTestId("contacts-detail-call")).toHaveLength(2);
    expect(screen.getAllByTestId("contacts-detail-text")).toHaveLength(2);

    // Email keeps the mailto: anchor (also deduped — two identical entries).
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

  it("Call/Text controls navigate to the Phone/Messages views via the eliza:navigate:view bus", async () => {
    await renderView();
    fireEvent.click(screen.getByText("Grace Hopper")); // single phone +15550200

    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("eliza:navigate:view", listener);
    try {
      fireEvent.click(screen.getByTestId("contacts-detail-call"));
      fireEvent.click(screen.getByTestId("contacts-detail-text"));
    } finally {
      window.removeEventListener("eliza:navigate:view", listener);
    }

    expect(events.map((e) => e.detail?.viewId)).toEqual(["phone", "messages"]);
  });

  it("shows the per-group emptyLabel when a contact has no emails", async () => {
    await renderView();

    fireEvent.click(screen.getByText("Grace Hopper")); // phone only, no email
    expect(screen.getByText("None")).toBeTruthy();
    // The phone it does have renders as in-app Call/Text controls.
    expect(screen.getByText("+15550200")).toBeTruthy();
    expect(screen.getByTestId("contacts-detail-call")).toBeTruthy();
    expect(screen.getByTestId("contacts-detail-text")).toBeTruthy();
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

describe("ContactsAppView — background poll (no manual refresh control)", () => {
  it("re-fetches on the poll interval and never renders a Refresh button", async () => {
    vi.useFakeTimers();
    try {
      render(React.createElement(ContactsAppView, overlayCtx()));

      // Flush the initial on-mount load (requestPermissions → listContacts →
      // setState is a chain of microtasks, so flush the queue a few times).
      await flushMicrotasks();
      expect(screen.getByText("Ada Lovelace")).toBeTruthy();
      expect(contactsBridge.listContacts).toHaveBeenCalledTimes(1);

      // The slop Refresh control is gone — assert it never renders.
      expect(screen.queryByTestId("contacts-refresh")).toBeNull();
      expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();

      // Advancing past one poll interval triggers a quiet refetch in place,
      // staying on the populated list.
      await vi.advanceTimersByTimeAsync(20000);
      await flushMicrotasks();
      expect(contactsBridge.listContacts).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
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
    await screen.findByText("None");
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

    await screen.findByText("None");
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
