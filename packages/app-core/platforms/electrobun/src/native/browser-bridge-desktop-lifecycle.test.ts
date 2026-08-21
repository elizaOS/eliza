/** Exercises desktop broker startup and shutdown hooks without installing browser registrations. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUnixBrokerTransportDescriptor } from "./browser-bridge-broker-transport";
import {
  desktopOwnerSessionFromCookies,
  isBrowserBridgeLoopbackApiBase,
  startBrowserBridgeDesktopLifecycle,
  stopBrowserBridgeDesktopLifecycle,
} from "./browser-bridge-desktop-lifecycle";

const roots: string[] = [];

describe("browser bridge desktop lifecycle", () => {
  afterEach(async () => {
    await stopBrowserBridgeDesktopLifecycle();
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts a private broker, delegates registration, and removes the socket on stop", async () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-lifecycle-"),
    );
    roots.push(stateDir);
    const env = {
      ELIZA_STATE_DIR: stateDir,
      ELIZA_BROWSER_BRIDGE_CHROME_EXTENSION_IDS:
        "abcdefghijklmnopabcdefghijklmnop",
    };
    const installRegistration = vi.fn();
    await expect(
      startBrowserBridgeDesktopLifecycle({
        apiBase: "http://127.0.0.1:31337",
        env,
        registrationPlan: { platform: process.platform, manifests: [] },
        installRegistration,
        macSafariKeychainHelperPath: "/Applications/Eliza.app/keychain-helper",
        macSafariAppGroupContainerPath: stateDir,
        macSafariAccessGroup: "ABCDEFGHIJ.ai.elizaos.browserbridge.shared",
        loadMacSafariSecret: () => Buffer.alloc(32, 7),
      }),
    ).resolves.toBe(true);
    const descriptor = createUnixBrokerTransportDescriptor(
      env,
      process.getuid?.() ?? 501,
    );
    expect(fs.statSync(descriptor.socketPath).mode & 0o777).toBe(0o600);
    expect(installRegistration).toHaveBeenCalledOnce();
    await stopBrowserBridgeDesktopLifecycle();
    expect(fs.existsSync(descriptor.socketPath)).toBe(false);
  });

  it("supports an explicit fail-closed administrative disable", async () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-lifecycle-empty-"),
    );
    roots.push(stateDir);
    await expect(
      startBrowserBridgeDesktopLifecycle({
        apiBase: "http://127.0.0.1:31337",
        env: {
          ELIZA_STATE_DIR: stateDir,
          ELIZA_BROWSER_BRIDGE_DISABLED: "true",
        },
      }),
    ).resolves.toBe(false);
  });

  it("recovers authenticated owner authority from the persistent renderer cookie jar", () => {
    const cookies = [
      {
        name: "eliza_session",
        value: "fresh-login-session",
        domain: "127.0.0.1",
        path: "/",
        expirationDate: 1_900_000_000,
      },
      {
        name: "eliza_csrf",
        value: "fresh-login-csrf",
        domain: "127.0.0.1",
        path: "/",
        expirationDate: 1_900_000_000,
      },
    ];
    expect(
      desktopOwnerSessionFromCookies(
        cookies,
        "http://127.0.0.1:31337",
        1_800_000_000_000,
      ),
    ).toEqual({
      sessionId: "fresh-login-session",
      csrfToken: "fresh-login-csrf",
      expiresAt: 1_900_000_000_000,
    });
    expect(
      desktopOwnerSessionFromCookies(
        cookies,
        "http://localhost:31337",
        1_800_000_000_000,
      ),
    ).toBeNull();
  });

  it("permits external-runtime startup only for an exact loopback API origin", () => {
    expect(isBrowserBridgeLoopbackApiBase("http://127.0.0.1:31337")).toBe(true);
    expect(isBrowserBridgeLoopbackApiBase("http://localhost:31337")).toBe(true);
    expect(isBrowserBridgeLoopbackApiBase("https://agent.example.com")).toBe(
      false,
    );
    expect(isBrowserBridgeLoopbackApiBase("http://127.0.0.1:31337/path")).toBe(
      false,
    );
  });
});
