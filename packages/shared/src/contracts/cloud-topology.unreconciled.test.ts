/**
 * Pins the config-vs-capability reconciliation for Eliza Cloud services
 * (elizaOS/eliza#20045 R3/R4). Config declares which capabilities route to
 * Cloud; a linked credential decides which of them can actually be served.
 * Those two sources previously never met, so a cloud-proxy route with no
 * account fell through to local silently. Pure data, no runtime.
 */
import { describe, expect, it } from "vitest";
import {
  hasUnreconciledElizaCloudServices,
  resolveElizaCloudTopology,
} from "./cloud-topology.js";

const cloudProxyText = {
  serviceRouting: {
    llmText: { backend: "elizacloud", transport: "cloud-proxy" },
  },
};

const linkedAccount = {
  linkedAccounts: { elizacloud: { status: "linked" } },
};

describe("resolveElizaCloudTopology — unreconciled services", () => {
  it("names inference unreconciled when cloud-proxy is configured with no account", () => {
    const topology = resolveElizaCloudTopology(cloudProxyText);
    // Intent is preserved: the routing entry really does say Cloud.
    expect(topology.services.inference).toBe(true);
    expect(topology.linked).toBe(false);
    // Capability is not: nothing can serve it.
    expect(topology.servicesUnreconciled).toEqual(["inference"]);
    expect(hasUnreconciledElizaCloudServices(cloudProxyText)).toBe(true);
  });

  it("reconciles once an account is linked", () => {
    const config = { ...cloudProxyText, ...linkedAccount };
    const topology = resolveElizaCloudTopology(config);
    expect(topology.linked).toBe(true);
    expect(topology.services.inference).toBe(true);
    expect(topology.servicesUnreconciled).toEqual([]);
    expect(hasUnreconciledElizaCloudServices(config)).toBe(false);
  });

  it("reconciles against a raw cloud API key as well as a linked account", () => {
    const config = { ...cloudProxyText, cloud: { apiKey: "sk-live-key" } };
    expect(resolveElizaCloudTopology(config).servicesUnreconciled).toEqual([]);
  });

  it("reports nothing unreconciled when no service routes to Cloud", () => {
    const config = {
      serviceRouting: { llmText: { backend: "ollama", transport: "direct" } },
    };
    const topology = resolveElizaCloudTopology(config);
    expect(topology.services.inference).toBe(false);
    expect(topology.servicesUnreconciled).toEqual([]);
    expect(hasUnreconciledElizaCloudServices(config)).toBe(false);
  });

  it("names every unservable Cloud-routed capability, not just inference", () => {
    const config = {
      serviceRouting: {
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
        tts: { backend: "elizacloud", transport: "cloud-proxy" },
        media: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    };
    const topology = resolveElizaCloudTopology(config);
    expect(new Set(topology.servicesUnreconciled)).toEqual(
      new Set(["inference", "tts", "media"]),
    );
  });

  it("treats a redacted key as no credential", () => {
    const config = { ...cloudProxyText, cloud: { apiKey: "[REDACTED]" } };
    expect(resolveElizaCloudTopology(config).servicesUnreconciled).toEqual([
      "inference",
    ]);
  });
});
