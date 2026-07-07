/**
 * Coverage for `detectHostCapabilities`, which classifies the runtime host
 * (Cloudflare Worker, Capacitor foreground-only, Capacitor + BackgroundRunner,
 * browser tab, full Node) from environment signals into a capability profile.
 * Each case pins the exact flag set (fs/inbound/longRunning/childProcess/net/
 * mobile/browser + label) a host kind exposes, which gates scheduling and
 * feature availability across surfaces.
 */
import { describe, expect, it } from "vitest";
import { detectHostCapabilities } from "./host-capabilities";

describe("detectHostCapabilities", () => {
  it("detects Cloudflare Workers as request-scoped HTTP hosts", () => {
    expect(
      detectHostCapabilities({ userAgent: "Cloudflare-Workers" }),
    ).toMatchObject({
      kind: "cloudflare-worker",
      fs: false,
      inbound: true,
      longRunning: false,
      childProcess: false,
      net: false,
      isMobile: false,
      isBrowser: false,
      label: "Cloudflare Worker",
    });
  });

  it("detects Capacitor foreground-only mobile hosts", () => {
    expect(
      detectHostCapabilities({ capacitor: { Plugins: {} } }),
    ).toMatchObject({
      kind: "capacitor-foreground-only",
      fs: false,
      inbound: false,
      longRunning: false,
      isMobile: true,
      isBrowser: false,
      label: "Mobile (Capacitor, foreground-only)",
    });
  });

  it("does NOT classify the Capacitor web shim as a mobile host (desktop/web local agent)", () => {
    // Every browser tab carries the Capacitor web shim (getPlatform() === "web",
    // isNativePlatform() === false). A desktop/web app running a local agent must
    // be a browser host, not `capacitor-foreground-only` — otherwise long-running
    // workflows + scheduled tasks wrongly refuse to start (the /api/lifeops 404s).
    const host = detectHostCapabilities({
      capacitor: {
        Plugins: {},
        getPlatform: () => "web",
        isNativePlatform: () => false,
      },
      hasWindow: true,
      hasProcess: false,
    });
    expect(host.isMobile).toBe(false);
    expect(host.kind).not.toBe("capacitor-foreground-only");
    expect(host.kind).toBe("browser");
  });

  it("still classifies a real native iOS/Android Capacitor shell as mobile", () => {
    expect(
      detectHostCapabilities({
        capacitor: {
          Plugins: {},
          getPlatform: () => "ios",
          isNativePlatform: () => true,
        },
      }),
    ).toMatchObject({
      kind: "capacitor-foreground-only",
      isMobile: true,
      label: "Mobile (Capacitor, foreground-only)",
    });
  });

  it("detects Capacitor hosts with BackgroundRunner", () => {
    expect(
      detectHostCapabilities({
        capacitor: { Plugins: { BackgroundRunner: {} } },
      }),
    ).toMatchObject({
      kind: "capacitor-background-runner",
      fs: false,
      inbound: false,
      longRunning: true,
      isMobile: true,
      isBrowser: false,
      label: "Mobile (Capacitor + BackgroundRunner)",
    });
  });

  it("detects browser tabs without a Node/Bun process", () => {
    expect(
      detectHostCapabilities({ hasWindow: true, hasProcess: false }),
    ).toMatchObject({
      kind: "browser",
      fs: false,
      inbound: false,
      longRunning: false,
      childProcess: false,
      net: false,
      isMobile: false,
      isBrowser: true,
      label: "Browser",
    });
  });

  it("falls back to a full Node host", () => {
    expect(detectHostCapabilities({})).toMatchObject({
      kind: "node",
      fs: true,
      inbound: true,
      longRunning: true,
      childProcess: true,
      net: true,
      isMobile: false,
      isBrowser: false,
      label: "Node",
    });
  });
});
