// @vitest-environment jsdom

// #10196 permission-gate — BEHAVIORAL render tests for the ElizaOS native app
// surfaces (Phone / Messages / Contacts). These assert the wiring the pure
// `ensureNativeReadGranted` unit test can't: that each page runs
// checkPermissions BEFORE the native read, never issues a read it knows will
// reject (which Capacitor would console.error), surfaces the denied state, and
// leaves the web-stub path (no permission model) unchanged.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock ONLY the native-bridge collaborator. The pages, the permission gate,
// the agent-surface instrumentation, and i18n all run for real.
const bridge = vi.hoisted(() => ({
  plugins: null as unknown,
}));

vi.mock("../../bridge/plugin-bridge", () => ({
  getPlugins: () => bridge.plugins,
}));

import {
  ContactsPageView,
  MessagesPageView,
  PhonePageView,
} from "./ElizaOsAppsView";

type Perm = "granted" | "denied" | "prompt";

function slice<T>(plugin: T) {
  return { plugin, isNative: true, hasFallback: false };
}

/** Build a messages plugin whose permission model is fully controllable. */
function messagesPlugin(opts: {
  check?: Perm;
  request?: Perm;
  withPermModel?: boolean;
  messages?: Array<{ id: string; body: string; address: string }>;
}) {
  const listMessages = vi.fn(async () => ({
    messages: (opts.messages ?? []).map((m) => ({
      id: m.id,
      threadId: "t1",
      address: m.address,
      body: m.body,
      date: 1_700_000_000_000,
      type: 1,
      read: true,
    })),
  }));
  const checkPermissions = vi.fn(async () => ({ sms: opts.check ?? "denied" }));
  const requestPermissions = vi.fn(async () => ({
    sms: opts.request ?? "denied",
  }));
  const plugin: Record<string, unknown> = { listMessages, sendSms: vi.fn() };
  if (opts.withPermModel !== false) {
    plugin.checkPermissions = checkPermissions;
    plugin.requestPermissions = requestPermissions;
  }
  return { plugin, listMessages, checkPermissions, requestPermissions };
}

function contactsPlugin(opts: {
  check?: Perm;
  request?: Perm;
  withPermModel?: boolean;
  contacts?: Array<{ id: string; displayName: string; phone?: string }>;
}) {
  const listContacts = vi.fn(async () => ({
    contacts: (opts.contacts ?? []).map((c) => ({
      id: c.id,
      lookupKey: c.id,
      displayName: c.displayName,
      phoneNumbers: c.phone ? [c.phone] : [],
      emailAddresses: [],
      starred: false,
    })),
  }));
  const checkPermissions = vi.fn(async () => ({
    contacts: opts.check ?? "denied",
  }));
  const requestPermissions = vi.fn(async () => ({
    contacts: opts.request ?? "denied",
  }));
  const plugin: Record<string, unknown> = {
    listContacts,
    createContact: vi.fn(),
    importVCard: vi.fn(),
  };
  if (opts.withPermModel !== false) {
    plugin.checkPermissions = checkPermissions;
    plugin.requestPermissions = requestPermissions;
  }
  return { plugin, listContacts, checkPermissions, requestPermissions };
}

function phonePlugin(opts: { check?: Perm; request?: Perm }) {
  const listRecentCalls = vi.fn(async () => ({ calls: [] }));
  const getStatus = vi.fn(async () => ({
    hasTelecom: true,
    canPlaceCalls: false,
    isDefaultDialer: false,
    defaultDialerPackage: null,
  }));
  const checkPermissions = vi.fn(async () => ({
    phone: opts.check ?? "denied",
  }));
  const requestPermissions = vi.fn(async () => ({
    phone: opts.request ?? "denied",
  }));
  const plugin = {
    getStatus,
    listRecentCalls,
    placeCall: vi.fn(),
    openDialer: vi.fn(),
    saveCallTranscript: vi.fn(),
    checkPermissions,
    requestPermissions,
  };
  return { plugin, listRecentCalls, getStatus, checkPermissions };
}

function systemPlugin() {
  return {
    plugin: {
      getStatus: vi.fn(async () => ({ packageName: "ai.eliza.app", roles: [] })),
      requestRole: vi.fn(),
      openSettings: vi.fn(),
      openNetworkSettings: vi.fn(),
    },
  };
}

function installPlugins(parts: {
  messages?: { plugin: unknown };
  contacts?: { plugin: unknown };
  phone?: { plugin: unknown };
  system?: { plugin: unknown };
}) {
  bridge.plugins = {
    messages: slice(parts.messages?.plugin ?? {}),
    contacts: slice(parts.contacts?.plugin ?? {}),
    phone: slice(parts.phone?.plugin ?? {}),
    system: slice(parts.system?.plugin ?? {}),
  };
}

afterEach(() => {
  cleanup();
  bridge.plugins = null;
  vi.clearAllMocks();
});

describe("MessagesPageView permission gate", () => {
  it("checks permission BEFORE the native read and, on denial, never reads", async () => {
    const m = messagesPlugin({ check: "denied", request: "denied" });
    installPlugins({ messages: m });

    render(<MessagesPageView />);

    // The gate resolves (check then request, both denied) before any read.
    await waitFor(() => expect(m.checkPermissions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(m.requestPermissions).toHaveBeenCalledTimes(1));

    // The whole point of #10196: a known-denied read is NEVER issued.
    expect(m.listMessages).not.toHaveBeenCalled();

    // Denied surfaces as the user-facing permission notice, not a raw error.
    expect(
      await screen.findByText(/SMS permission is required/i),
    ).toBeTruthy();
  });

  it("reads only after a granted check, and in that order", async () => {
    const m = messagesPlugin({
      check: "granted",
      messages: [{ id: "s1", body: "hello from android", address: "+15551230000" }],
    });
    installPlugins({ messages: m });

    render(<MessagesPageView />);

    await waitFor(() => expect(m.listMessages).toHaveBeenCalledTimes(1));

    // Ordering: check resolved before the read fired.
    expect(m.checkPermissions.mock.invocationCallOrder[0]).toBeLessThan(
      m.listMessages.mock.invocationCallOrder[0],
    );
    // Already granted → no user prompt.
    expect(m.requestPermissions).not.toHaveBeenCalled();

    // DTO round-trips into the DOM.
    expect(await screen.findByText("hello from android")).toBeTruthy();
  });

  it("requests once when prompt, then reads after the user grants", async () => {
    const m = messagesPlugin({
      check: "prompt",
      request: "granted",
      messages: [{ id: "s2", body: "after grant", address: "+1999" }],
    });
    installPlugins({ messages: m });

    render(<MessagesPageView />);

    await waitFor(() => expect(m.requestPermissions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(m.listMessages).toHaveBeenCalledTimes(1));
    expect(m.checkPermissions.mock.invocationCallOrder[0]).toBeLessThan(
      m.requestPermissions.mock.invocationCallOrder[0],
    );
    expect(m.requestPermissions.mock.invocationCallOrder[0]).toBeLessThan(
      m.listMessages.mock.invocationCallOrder[0],
    );
    expect(await screen.findByText("after grant")).toBeTruthy();
  });

  it("web-stub path (no permission model) reads directly", async () => {
    const m = messagesPlugin({
      withPermModel: false,
      messages: [{ id: "w1", body: "web message", address: "+1web" }],
    });
    installPlugins({ messages: m });

    render(<MessagesPageView />);

    await waitFor(() => expect(m.listMessages).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("web message")).toBeTruthy();
    expect(
      screen.queryByText(/SMS permission is required/i),
    ).toBeNull();
  });
});

describe("ContactsPageView permission gate", () => {
  it("does not read the address book when contacts permission is denied", async () => {
    const c = contactsPlugin({ check: "denied", request: "denied" });
    installPlugins({ contacts: c });

    render(<ContactsPageView />);

    await waitFor(() => expect(c.checkPermissions).toHaveBeenCalledTimes(1));
    expect(c.listContacts).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Contacts permission is required/i),
    ).toBeTruthy();
  });

  it("reads and renders contacts after a granted check", async () => {
    const c = contactsPlugin({
      check: "granted",
      contacts: [{ id: "c1", displayName: "Ada Lovelace", phone: "+1867" }],
    });
    installPlugins({ contacts: c });

    render(<ContactsPageView />);

    await waitFor(() => expect(c.listContacts).toHaveBeenCalledTimes(1));
    expect(c.checkPermissions.mock.invocationCallOrder[0]).toBeLessThan(
      c.listContacts.mock.invocationCallOrder[0],
    );
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
  });
});

describe("PhonePageView per-permission gate", () => {
  it("gates each read independently: denied phone skips the call log, granted contacts still loads", async () => {
    const p = phonePlugin({ check: "denied", request: "denied" });
    const c = contactsPlugin({
      check: "granted",
      contacts: [{ id: "pc1", displayName: "Grace Hopper", phone: "+1234" }],
    });
    const s = systemPlugin();
    installPlugins({ phone: p, contacts: c, system: s });

    const { container } = render(<PhonePageView />);

    // Permission-free status reads always run.
    await waitFor(() => expect(p.getStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(c.listContacts).toHaveBeenCalledTimes(1));

    // Phone permission denied → the call-log read is suppressed entirely,
    // while the granted contacts read proceeds. This is the per-permission
    // gate, not an all-or-nothing block.
    expect(p.checkPermissions).toHaveBeenCalled();
    expect(p.listRecentCalls).not.toHaveBeenCalled();

    // The contacts read happened only after its own permission check.
    expect(c.checkPermissions.mock.invocationCallOrder[0]).toBeLessThan(
      c.listContacts.mock.invocationCallOrder[0],
    );

    // The partial-denial notice names phone only (contacts loaded fine).
    expect(
      await screen.findByText(
        /Phone permission is required to load recent calls/i,
      ),
    ).toBeTruthy();

    // The granted contacts read's data round-trips once its panel is shown.
    const contactsTab = container.querySelector<HTMLButtonElement>(
      '[data-agent-id="phone-tab-contacts"]',
    );
    if (!contactsTab) throw new Error("contacts tab not rendered");
    fireEvent.click(contactsTab);
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
  });
});
