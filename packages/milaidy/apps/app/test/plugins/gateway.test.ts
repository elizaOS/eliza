/**
 * Tests for @milaidy/capacitor-gateway plugin
 *
 * Verifies:
 * - Module exports (GatewayWeb class + definition types)
 * - Discovery returns empty on web (no Bonjour/mDNS)
 * - Connection state management
 * - Send returns error when not connected
 * - Connection info defaults
 * - Listener registration and cleanup
 */
import { describe, it, expect, beforeEach } from "vitest";
import { GatewayWeb } from "../../plugins/gateway/src/web";

describe("@milaidy/capacitor-gateway", () => {
  let gateway: GatewayWeb;

  beforeEach(() => {
    gateway = new GatewayWeb();
  });

  describe("module exports", () => {
    it("exports GatewayWeb class", () => {
      expect(GatewayWeb).toBeDefined();
      expect(typeof GatewayWeb).toBe("function");
    });

    it("creates an instance with all expected methods", () => {
      expect(typeof gateway.startDiscovery).toBe("function");
      expect(typeof gateway.stopDiscovery).toBe("function");
      expect(typeof gateway.getDiscoveredGateways).toBe("function");
      expect(typeof gateway.connect).toBe("function");
      expect(typeof gateway.disconnect).toBe("function");
      expect(typeof gateway.isConnected).toBe("function");
      expect(typeof gateway.send).toBe("function");
      expect(typeof gateway.getConnectionInfo).toBe("function");
      expect(typeof gateway.addListener).toBe("function");
      expect(typeof gateway.removeAllListeners).toBe("function");
    });
  });

  describe("discovery (not supported on web)", () => {
    it("startDiscovery returns empty gateways list", async () => {
      const result = await gateway.startDiscovery();
      expect(result.gateways).toEqual([]);
      expect(result.status).toContain("not supported");
    });

    it("stopDiscovery completes without error", async () => {
      await expect(gateway.stopDiscovery()).resolves.toBeUndefined();
    });

    it("getDiscoveredGateways returns empty list", async () => {
      const result = await gateway.getDiscoveredGateways();
      expect(result.gateways).toEqual([]);
    });
  });

  describe("connection state", () => {
    it("reports not connected initially", async () => {
      const result = await gateway.isConnected();
      expect(result.connected).toBe(false);
    });

    it("getConnectionInfo returns nulls when not connected", async () => {
      const info = await gateway.getConnectionInfo();
      expect(info.url).toBeNull();
      expect(info.sessionId).toBeNull();
      expect(info.protocol).toBeNull();
      expect(info.role).toBeNull();
    });
  });

  describe("send without connection", () => {
    it("returns error when not connected", async () => {
      const result = await gateway.send({ method: "test.method" });
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("NOT_CONNECTED");
      expect(result.error!.message).toContain("Not connected");
    });
  });

  describe("disconnect", () => {
    it("completes without error even when not connected", async () => {
      await expect(gateway.disconnect()).resolves.toBeUndefined();
    });

    it("clears connection state after disconnect", async () => {
      await gateway.disconnect();
      const info = await gateway.getConnectionInfo();
      expect(info.sessionId).toBeNull();
      expect(info.protocol).toBeNull();
    });
  });

  describe("event listeners", () => {
    it("registers gatewayEvent listener", async () => {
      let received = false;
      const handle = await gateway.addListener("gatewayEvent", () => {
        received = true;
      });
      expect(handle).toBeDefined();
      expect(typeof handle.remove).toBe("function");
      await handle.remove();
    });

    it("registers stateChange listener", async () => {
      const handle = await gateway.addListener("stateChange", () => {});
      expect(handle).toBeDefined();
      await handle.remove();
    });

    it("registers error listener", async () => {
      const handle = await gateway.addListener("error", () => {});
      expect(handle).toBeDefined();
      await handle.remove();
    });

    it("removeAllListeners clears all", async () => {
      await gateway.addListener("gatewayEvent", () => {});
      await gateway.addListener("stateChange", () => {});
      await gateway.addListener("error", () => {});
      await gateway.removeAllListeners();
      // No error means success
    });
  });
});
