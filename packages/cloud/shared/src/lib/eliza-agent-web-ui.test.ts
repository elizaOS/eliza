/**
 * Unit tests for resolving public, direct, and client-safe Eliza agent web UI URLs.
 */

import { describe, expect, it } from "vitest";
import {
  getAgentBaseDomain,
  getClientSafeElizaAgentWebUiUrl,
  getElizaAgentDirectWebUiUrl,
  getElizaAgentPublicWebUiUrl,
  getPreferredElizaAgentWebUiUrl,
} from "./eliza-agent-web-ui.js";

describe("eliza-agent-web-ui", () => {
  it("resolves default agent base domain", () => {
    expect(getAgentBaseDomain()).toBe("cloud.eliza.app");
  });

  it("builds public web UI URL for sandbox", () => {
    const sandbox = { id: "sandbox-123", headscale_ip: "100.64.0.5" };

    const url = getElizaAgentPublicWebUiUrl(sandbox);
    expect(url).toBe("https://sandbox-123.cloud.eliza.app");

    const customUrl = getElizaAgentPublicWebUiUrl(sandbox, {
      baseDomain: "custom.domain.com",
      path: "/chat?tab=1",
    });
    expect(customUrl).toBe("https://sandbox-123.custom.domain.com/chat?tab=1");

    // Null or invalid baseDomain returns null
    expect(getElizaAgentPublicWebUiUrl(sandbox, { baseDomain: null })).toBeNull();
    expect(getElizaAgentPublicWebUiUrl(sandbox, { baseDomain: "" })).toBeNull();
  });

  it("builds direct headscale web UI URL for sandbox", () => {
    const sandboxWithWebPort = {
      id: "sb-1",
      headscale_ip: "100.64.0.10",
      web_ui_port: 3000,
      bridge_port: 3001,
    };

    expect(getElizaAgentDirectWebUiUrl(sandboxWithWebPort)).toBe("http://100.64.0.10:3000");

    const sandboxWithBridgeOnly = {
      id: "sb-2",
      headscale_ip: "100.64.0.11",
      bridge_port: 4000,
    };

    expect(getElizaAgentDirectWebUiUrl(sandboxWithBridgeOnly, { path: "/status" })).toBe(
      "http://100.64.0.11:4000/status",
    );

    const sandboxNoIp = {
      id: "sb-3",
      web_ui_port: 3000,
    };
    expect(getElizaAgentDirectWebUiUrl(sandboxNoIp)).toBeNull();
  });

  it("resolves preferred and client-safe URLs", () => {
    const sandbox = {
      id: "sb-4",
      headscale_ip: "100.64.0.12",
      web_ui_port: 3000,
      canonicalWebUiUrl: "https://canonical.eliza.app/agent/sb-4",
    };

    expect(getPreferredElizaAgentWebUiUrl(sandbox)).toBe("https://sb-4.cloud.eliza.app");

    expect(getClientSafeElizaAgentWebUiUrl(sandbox, { path: "/dashboard" })).toBe(
      "https://canonical.eliza.app/dashboard",
    );

    expect(getClientSafeElizaAgentWebUiUrl({ id: "sb-5" })).toBeNull();
  });
});
