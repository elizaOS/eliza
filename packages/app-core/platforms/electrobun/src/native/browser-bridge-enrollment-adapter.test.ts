/** Exercises owner-authorized native enrollment against a deterministic loopback pairing API. */

import { describe, expect, it, vi } from "vitest";
import { pairBrowserBridgeCompanionAsDesktopOwner } from "./browser-bridge-enrollment-adapter";

const ownerSession = {
  sessionId: "owner-session",
  csrfToken: "owner-csrf",
  expiresAt: Date.now() + 60_000,
};

describe("browser bridge enrollment adapter", () => {
  it("uses the existing owner cookie and CSRF authority on loopback", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            companion: {
              id: "companion-1",
              browser: "chrome",
              profileId: "Default",
              profileLabel: "Personal",
              label: "Chrome Personal",
            },
            pairingToken: "pairing-secret",
            pairingTokenExpiresAt: "2030-01-01T00:00:00.000Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      pairBrowserBridgeCompanionAsDesktopOwner({
        apiBase: "http://127.0.0.1:31337",
        ownerSession,
        payload: {
          browser: "chrome",
          profileId: "Default",
          extensionVersion: "1.2.3",
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      companion: { id: "companion-1" },
      pairingToken: "pairing-secret",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:31337/api/browser-bridge/companions/pair"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          cookie: "eliza_session=owner-session",
          "x-eliza-csrf": "owner-csrf",
        }),
      }),
    );
  });

  it("rejects non-loopback APIs, expired authority, and incomplete responses", async () => {
    await expect(
      pairBrowserBridgeCompanionAsDesktopOwner({
        apiBase: "https://example.com",
        ownerSession,
        payload: {
          browser: "chrome",
          profileId: "Default",
          extensionVersion: "1.2.3",
        },
      }),
    ).rejects.toThrow("loopback");
    await expect(
      pairBrowserBridgeCompanionAsDesktopOwner({
        apiBase: "http://127.0.0.1:31337",
        ownerSession: { ...ownerSession, expiresAt: 1 },
        payload: {
          browser: "chrome",
          profileId: "Default",
          extensionVersion: "1.2.3",
        },
      }),
    ).rejects.toThrow("expired");
    await expect(
      pairBrowserBridgeCompanionAsDesktopOwner({
        apiBase: "http://127.0.0.1:31337",
        ownerSession,
        payload: {
          browser: "chrome",
          profileId: "Default",
          extensionVersion: "1.2.3",
        },
        fetchImpl: async () => new Response("{}", { status: 201 }),
      }),
    ).rejects.toThrow("companion is invalid");
  });
});
