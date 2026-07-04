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
