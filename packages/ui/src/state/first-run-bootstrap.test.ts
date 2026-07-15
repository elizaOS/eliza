// @vitest-environment jsdom

/**
 * Existing-install boot probe (`first-run-bootstrap`): detection of a returning
 * local/self-hosted install and the #16242 gate that skips the probe on a bare
 * Eliza Cloud control-plane origin (where the same-origin API is auth-gated and
 * would only 401). Drives the real functions with a fake probe client — no
 * network — and stubs `window.location.origin` to exercise the origin gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectExistingFirstRunConnection,
  type ExistingFirstRunProbeClient,
  shouldProbeExistingLocalInstall,
} from "./first-run-bootstrap";

const originalLocation = Object.getOwnPropertyDescriptor(window, "location");

function setOrigin(url: string): void {
  const u = new URL(url);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: u.href,
      origin: u.origin,
      protocol: u.protocol,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      assign: () => {},
      replace: () => {},
      reload: () => {},
      toString: () => u.href,
    },
  });
}

function makeClient(
  overrides: Partial<ExistingFirstRunProbeClient> = {},
): ExistingFirstRunProbeClient {
  return {
    apiAvailable: true,
    getFirstRunStatus: vi.fn(async () => ({ complete: false })),
    getConfig: vi.fn(async () => ({})),
    ...overrides,
  };
}

afterEach(() => {
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  }
});

describe("shouldProbeExistingLocalInstall (#16242)", () => {
  it("is false only on a bare Cloud control-plane origin", () => {
    expect(shouldProbeExistingLocalInstall("https://app.elizacloud.ai")).toBe(
      false,
    );
    expect(shouldProbeExistingLocalInstall("https://elizacloud.ai")).toBe(
      false,
    );
    expect(shouldProbeExistingLocalInstall("http://localhost:2138")).toBe(true);
    expect(shouldProbeExistingLocalInstall("https://agent.example.com")).toBe(
      true,
    );
    expect(shouldProbeExistingLocalInstall(null)).toBe(true);
    expect(shouldProbeExistingLocalInstall(undefined)).toBe(true);
  });
});

describe("detectExistingFirstRunConnection", () => {
  beforeEach(() => {
    setOrigin("http://localhost:2138/");
  });

  it("returns null and never probes when the API is unavailable", async () => {
    const client = makeClient({ apiAvailable: false });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toBeNull();
    expect(client.getFirstRunStatus).not.toHaveBeenCalled();
  });

  it("skips the probe on a Cloud control-plane origin (#16242)", async () => {
    setOrigin("https://app.elizacloud.ai/");
    const client = makeClient();
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toBeNull();
    // The gate returns before any protected probe is issued.
    expect(client.getFirstRunStatus).not.toHaveBeenCalled();
    expect(client.getConfig).not.toHaveBeenCalled();
  });

  it("detects a completed backend install from first-run status", async () => {
    const client = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: true })),
    });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ detectedExistingInstall: true });
    expect(result?.activeServer.kind).toBe("local");
    expect(client.getConfig).not.toHaveBeenCalled();
  });

  it("detects an existing install from persisted config when first-run is incomplete", async () => {
    const client = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: false })),
      getConfig: vi.fn(async () => ({ meta: { firstRunComplete: true } })),
    });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ detectedExistingInstall: true });
    expect(client.getConfig).toHaveBeenCalledTimes(1);
  });

  it("returns null when no install is detected (incomplete + empty config)", async () => {
    const client = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: false })),
      getConfig: vi.fn(async () => ({})),
    });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toBeNull();
  });

  it("returns null when the status probe throws (agent unreachable)", async () => {
    const client = makeClient({
      getFirstRunStatus: vi.fn(async () => {
        throw new Error("unreachable");
      }),
    });
    const result = await detectExistingFirstRunConnection({
      client,
      timeoutMs: 1000,
    });
    expect(result).toBeNull();
  });
});
