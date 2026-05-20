import { describe, expect, it } from "bun:test";
import {
  outboundReadiness,
  recipientFromChatGuid,
  senderOptions,
  shortcutValidationMatches,
  type BlueBubblesServerInfoForReadiness,
} from "./bluebubbles-local-bridge-readiness";

const readyServerInfo: BlueBubblesServerInfoForReadiness = {
  data: {
    private_api: true,
    helper_connected: true,
  },
};

const readyAppleEvents = [
  { target: "Finder" as const, ok: true },
  { target: "System Events" as const, ok: true },
  { target: "Messages" as const, ok: true },
];

const readyShortcuts = {
  available: true,
  shortcuts: ["Eliza Cloud Send Message Ready"],
  validation: {
    required: true,
    validated: true,
  },
};

const base = {
  hasBlueBubblesPassword: true,
  serverInfo: readyServerInfo,
  sipStatus: "System Integrity Protection status: disabled.",
  pendingReplies: [],
  appleEvents: readyAppleEvents,
  shortcuts: readyShortcuts,
  shortcutsSendShortcutName: "Eliza Cloud Send Message Ready",
};

describe("BlueBubbles local bridge readiness", () => {
  it("extracts a Shortcut recipient from a BlueBubbles chat guid", () => {
    expect(recipientFromChatGuid("SMS;-;+14155550123")).toBe("+14155550123");
    expect(recipientFromChatGuid("iMessage;-;person@example.com")).toBe(
      "person@example.com",
    );
    expect(recipientFromChatGuid("not-a-guid")).toBeNull();
  });

  it("reports every sender mode when every prerequisite is ready", () => {
    expect(senderOptions(base)).toEqual([
      { method: "apple-script", ready: true, reasons: [] },
      { method: "private-api", ready: true, reasons: [] },
      { method: "shortcuts", ready: true, reasons: [] },
    ]);
  });

  it("keeps alternate sender modes visible when AppleScript is blocked", () => {
    const options = senderOptions({
      ...base,
      pendingReplies: [
        { lastError: "BlueBubbles send timed out after 45000ms using apple-script" },
      ],
      appleEvents: [
        ...readyAppleEvents.slice(0, 2),
        {
          target: "Messages" as const,
          ok: false,
          error: "Command failed: osascript Messages",
        },
      ],
    });

    expect(options.find((option) => option.method === "apple-script")).toMatchObject({
      ready: false,
    });
    expect(options.find((option) => option.method === "private-api")).toMatchObject({
      ready: true,
    });
    expect(options.find((option) => option.method === "shortcuts")).toMatchObject({
      ready: true,
    });
  });

  it("surfaces Messages AppleEvents timeout detail", () => {
    const options = senderOptions({
      ...base,
      appleEvents: [
        ...readyAppleEvents.slice(0, 2),
        {
          target: "Messages" as const,
          ok: false,
          error:
            "Messages AppleEvents probe timed out after 3000ms; Command failed: osascript Messages; signal=SIGTERM",
        },
      ],
    });

    expect(options.find((option) => option.method === "apple-script")).toMatchObject({
      ready: false,
      reasons: [
        "Messages AppleEvents unavailable: Messages AppleEvents probe timed out after 3000ms; Command failed: osascript Messages; signal=SIGTERM",
      ],
    });
  });

  it("does not treat queued replies as a Shortcuts readiness failure", () => {
    expect(
      outboundReadiness({
        ...base,
        method: "shortcuts",
        pendingReplies: [
          { lastError: "BlueBubbles send timed out after 45000ms using apple-script" },
        ],
      }),
    ).toEqual({ method: "shortcuts", ready: true, reasons: [] });
  });

  it("requires a successful Shortcuts validation send when configured", () => {
    expect(
      outboundReadiness({
        ...base,
        method: "shortcuts",
        shortcuts: {
          ...readyShortcuts,
          validation: {
            required: true,
            validated: false,
            detail: "no successful validation send recorded",
          },
        },
      }),
    ).toEqual({
      method: "shortcuts",
      ready: false,
      reasons: [
        "Shortcut outbound validation missing: no successful validation send recorded",
      ],
    });
  });

  it("explains missing ready Shortcuts setup", () => {
    expect(
      outboundReadiness({
        ...base,
        method: "shortcuts",
        shortcuts: { available: true, shortcuts: [] },
      }),
    ).toEqual({
      method: "shortcuts",
      ready: false,
      reasons: ['Shortcut "Eliza Cloud Send Message Ready" is not installed'],
    });
  });

  it("lists installed Shortcuts when the ready Shortcut name is missing", () => {
    expect(
      outboundReadiness({
        ...base,
        method: "shortcuts",
        shortcuts: {
          available: true,
          shortcuts: ["Eliza Cloud Send Message"],
        },
        shortcutsSendShortcutName: "Eliza Cloud Send Message Ready",
      }),
    ).toEqual({
      method: "shortcuts",
      ready: false,
      reasons: [
        'Shortcut "Eliza Cloud Send Message Ready" is not installed; installed shortcuts: Eliza Cloud Send Message',
      ],
    });
  });

  it("accepts a configured Shortcut id when the display name is absent", () => {
    expect(
      outboundReadiness({
        ...base,
        method: "shortcuts",
        shortcutsSendShortcutName: "Renamed Shortcut",
        shortcutsSendShortcutId: "785A8251-AC4B-4D3F-B0AA-C66188E6F2A3",
        shortcuts: {
          available: true,
          shortcuts: ["Eliza Cloud Send Message Ready 4"],
          shortcutIdentifiers: {
            "Eliza Cloud Send Message Ready 4":
              "785A8251-AC4B-4D3F-B0AA-C66188E6F2A3",
          },
          validation: {
            required: true,
            validated: true,
          },
        },
      }),
    ).toEqual({ method: "shortcuts", ready: true, reasons: [] });
  });

  it("matches Shortcut validation by id when an id is configured", () => {
    expect(
      shortcutValidationMatches({
        shortcutsSendShortcutName: "Eliza Cloud Send Message Ready",
        shortcutsSendShortcutId: "785A8251-AC4B-4D3F-B0AA-C66188E6F2A3",
        record: {
          method: "shortcuts",
          shortcutName: "Eliza Cloud Send Message Ready",
        },
      }),
    ).toBe(false);

    expect(
      shortcutValidationMatches({
        shortcutsSendShortcutName: "Eliza Cloud Send Message Ready",
        shortcutsSendShortcutId: "785A8251-AC4B-4D3F-B0AA-C66188E6F2A3",
        record: {
          method: "shortcuts",
          shortcutName: "Eliza Cloud Send Message Ready",
          shortcutId: "785A8251-AC4B-4D3F-B0AA-C66188E6F2A3",
        },
      }),
    ).toBe(true);
  });
});
