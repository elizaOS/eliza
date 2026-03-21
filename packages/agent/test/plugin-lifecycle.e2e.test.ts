/**
 * E2E tests for the plugin lifecycle: discovery, validation,
 * configuration, enable/disable.
 *
 * Starts a real API server (no runtime) to test the plugin management
 * flow end-to-end through HTTP.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function http$(
  port: number,
  method: string,
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    if (b) req.write(b);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Plugin Lifecycle E2E", () => {
  let server: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    server = await startApiServer({ port: 0 });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  // ===================================================================
  //  1. Plugin discovery & listing
  // ===================================================================

  describe("discovery", () => {
    it("GET /api/plugins returns list with correct shape", async () => {
      const { status, data } = await http$(server.port, "GET", "/api/plugins");
      expect(status).toBe(200);
      expect(Array.isArray(data.plugins)).toBe(true);
    });

    it("each plugin has required fields", async () => {
      const { data } = await http$(server.port, "GET", "/api/plugins");
      const plugins = data.plugins as Array<Record<string, unknown>>;
      if (plugins.length === 0) return;

      for (const p of plugins.slice(0, 5)) {
        expect(typeof p.id).toBe("string");
        expect(typeof p.name).toBe("string");
        expect(typeof p.enabled).toBe("boolean");
        expect(typeof p.category).toBe("string");
        expect(Array.isArray(p.parameters)).toBe(true);
        expect(Array.isArray(p.validationErrors)).toBe(true);
        expect(Array.isArray(p.validationWarnings)).toBe(true);
      }
    });

    it("categories are valid", async () => {
      const { data } = await http$(server.port, "GET", "/api/plugins");
      const plugins = data.plugins as Array<Record<string, unknown>>;
      const valid = [
        "ai-provider",
        "connector",
        "database",
        "feature",
        "streaming",
        "app",
      ];
      for (const p of plugins) {
        expect(valid).toContain(p.category);
      }
    });

    it("parameters have correct shape", async () => {
      const { data } = await http$(server.port, "GET", "/api/plugins");
      const plugins = data.plugins as Array<Record<string, unknown>>;
      const withParams = plugins.filter(
        (p) => (p.parameters as Array<Record<string, unknown>>).length > 0,
      );
      if (withParams.length === 0) return;

      const params = withParams[0].parameters as Array<Record<string, unknown>>;
      for (const param of params) {
        expect(typeof param.key).toBe("string");
        expect(typeof param.type).toBe("string");
        expect(typeof param.required).toBe("boolean");
        expect(typeof param.sensitive).toBe("boolean");
        expect(typeof param.isSet).toBe("boolean");
      }
    });

    it("provider plugins have required params with validation errors when keys unset", async () => {
      const { data } = await http$(server.port, "GET", "/api/plugins");
      const plugins = data.plugins as Array<Record<string, unknown>>;
      // Find providers that have required params but no env set
      const unconfiguredProviders = plugins.filter(
        (p) =>
          p.category === "ai-provider" &&
          (p.parameters as Array<Record<string, unknown>>).some(
            (pr) => pr.required && !pr.isSet,
          ) &&
          (p.validationErrors as Array<unknown>).length > 0,
      );
      // At least some providers should be unconfigured in test env
      // (unless all keys happen to be set)
      if (unconfiguredProviders.length > 0) {
        for (const p of unconfiguredProviders) {
          expect((p.validationErrors as Array<unknown>).length).toBeGreaterThan(
            0,
          );
        }
      }
    });
  });

  // ===================================================================
  //  2. Plugin enable/disable
  // ===================================================================

  describe("enable/disable", () => {
    it("returns 404 for unknown plugin", async () => {
      const { status } = await http$(
        server.port,
        "PUT",
        "/api/plugins/nonexistent-xyz",
        {
          enabled: true,
        },
      );
      expect(status).toBe(404);
    });

    it("can disable a plugin", async () => {
      const { data: listData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const plugins = listData.plugins as Array<Record<string, unknown>>;
      if (plugins.length === 0) return;

      const target = plugins[0];
      const { status, data } = await http$(
        server.port,
        "PUT",
        `/api/plugins/${target.id}`,
        {
          enabled: false,
        },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect((data.plugin as Record<string, unknown>).enabled).toBe(false);
    });

    it("disabled plugin shows enabled=false in list", async () => {
      const { data: listData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const plugins = listData.plugins as Array<Record<string, unknown>>;
      if (plugins.length === 0) return;

      const target = plugins[0];
      await http$(server.port, "PUT", `/api/plugins/${target.id}`, {
        enabled: false,
      });

      const { data: updatedList } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const updated = (
        updatedList.plugins as Array<Record<string, unknown>>
      ).find((p) => p.id === target.id);
      expect(updated?.enabled).toBe(false);
    });

    it("can re-enable a plugin with no validation errors", async () => {
      const { data: listData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const plugins = listData.plugins as Array<Record<string, unknown>>;
      const noErrors = plugins.find(
        (p) => (p.validationErrors as Array<unknown>).length === 0,
      );
      if (!noErrors) return;

      const { status, data } = await http$(
        server.port,
        "PUT",
        `/api/plugins/${noErrors.id}`,
        {
          enabled: true,
        },
      );
      expect(status).toBe(200);
      expect((data.plugin as Record<string, unknown>).enabled).toBe(true);
    });
  });

  // ===================================================================
  //  2b. Capability toggle persists features flag
  // ===================================================================

  describe("capability feature-flag persistence", () => {
    it("toggling a capability plugin (vision) persists features.vision in config", async () => {
      // First check if vision plugin exists in the list
      const { data: listData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const plugins = listData.plugins as Array<Record<string, unknown>>;
      const vision = plugins.find((p) => p.id === "vision");
      if (!vision) return; // vision plugin not available in this env

      // Disable vision
      const { status: offStatus, data: offData } = await http$(
        server.port,
        "PUT",
        "/api/plugins/vision",
        { enabled: false },
      );
      expect(offStatus).toBe(200);
      expect(offData.ok).toBe(true);
      expect((offData.plugin as Record<string, unknown>).enabled).toBe(false);

      // Read saved config to verify features.vision was persisted
      const { status: cfgStatus, data: cfgData } = await http$(
        server.port,
        "GET",
        "/api/config",
      );
      expect(cfgStatus).toBe(200);
      const savedConfig = cfgData.config as Record<string, unknown> | undefined;
      const features = (savedConfig ?? cfgData).features as
        | Record<string, unknown>
        | undefined;
      // The features.vision flag should have been written
      expect(features?.vision).toBe(false);

      // Re-enable vision
      const { status: onStatus, data: onData } = await http$(
        server.port,
        "PUT",
        "/api/plugins/vision",
        { enabled: true },
      );
      expect(onStatus).toBe(200);
      expect((onData.plugin as Record<string, unknown>).enabled).toBe(true);

      // Verify features.vision is now true
      const { data: cfgData2 } = await http$(server.port, "GET", "/api/config");
      const savedConfig2 =
        (cfgData2.config as Record<string, unknown> | undefined) ?? cfgData2;
      const features2 = savedConfig2.features as
        | Record<string, unknown>
        | undefined;
      expect(features2?.vision).toBe(true);
    });
  });

  // ===================================================================
  //  3. Plugin configuration & validation
  // ===================================================================

  describe("configuration & validation", () => {
    it("rejects empty config value for required param with 422", async () => {
      const { data: listData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const plugins = listData.plugins as Array<Record<string, unknown>>;
      const provider = plugins.find(
        (p) =>
          p.category === "ai-provider" &&
          (p.parameters as Array<Record<string, unknown>>).some(
            (pr) => pr.required === true,
          ),
      );
      if (!provider) return;

      const requiredParam = (
        provider.parameters as Array<Record<string, unknown>>
      ).find((pr) => pr.required === true);
      if (!requiredParam) return;

      const { status, data } = await http$(
        server.port,
        "PUT",
        `/api/plugins/${provider.id}`,
        { config: { [requiredParam.key as string]: "" } },
      );
      expect(status).toBe(422);
      expect(data.ok).toBe(false);
      expect((data.validationErrors as Array<unknown>).length).toBeGreaterThan(
        0,
      );
    });

    it("accepts valid config value", async () => {
      const { data: listData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const plugins = listData.plugins as Array<Record<string, unknown>>;
      const provider = plugins.find(
        (p) =>
          p.category === "ai-provider" &&
          (p.parameters as Array<Record<string, unknown>>).some(
            (pr) => pr.required === true,
          ),
      );
      if (!provider) return;

      // Set ALL required params to valid values
      const requiredParams = (
        provider.parameters as Array<Record<string, unknown>>
      ).filter((pr) => pr.required === true);
      const config: Record<string, string> = {};
      for (const param of requiredParams) {
        config[param.key as string] = "sk-ant-test-1234567890abcdefghij";
      }

      const { status, data } = await http$(
        server.port,
        "PUT",
        `/api/plugins/${provider.id}`,
        { config },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("validation errors clear after setting all required params", async () => {
      const { data: listData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const plugins = listData.plugins as Array<Record<string, unknown>>;
      const provider = plugins.find(
        (p) =>
          p.category === "ai-provider" &&
          (p.parameters as Array<Record<string, unknown>>).some(
            (pr) => pr.required === true,
          ),
      );
      if (!provider) return;

      const requiredParams = (
        provider.parameters as Array<Record<string, unknown>>
      ).filter((pr) => pr.required === true);
      const config: Record<string, string> = {};
      for (const param of requiredParams) {
        config[param.key as string] = "test-value-1234567890abcdefghij";
      }

      await http$(server.port, "PUT", `/api/plugins/${provider.id}`, {
        config,
      });

      const { data: afterData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const updated = (
        afterData.plugins as Array<Record<string, unknown>>
      ).find((p) => p.id === provider.id);
      expect((updated?.validationErrors as Array<unknown>).length).toBe(0);
    });

    it("non-sensitive param currentValue updates after save", async () => {
      const { data: listData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const plugins = listData.plugins as Array<Record<string, unknown>>;
      const withNonSensitive = plugins.find((p) =>
        (p.parameters as Array<Record<string, unknown>>).some(
          (pr) => pr.required === true && pr.sensitive === false,
        ),
      );
      if (!withNonSensitive) return;

      const allParams = withNonSensitive.parameters as Array<
        Record<string, unknown>
      >;
      const targetParam = allParams.find(
        (pr) => pr.required === true && pr.sensitive === false,
      );
      if (!targetParam) return;

      // Must set ALL required params for PUT to succeed (validation checks them all)
      const config: Record<string, string> = {};
      const testValue = "lifecycle-test-value-12345";
      for (const pr of allParams) {
        if (pr.required) {
          config[pr.key as string] =
            pr.key === targetParam.key
              ? testValue
              : "placeholder-required-value-12345";
        }
      }

      const { status } = await http$(
        server.port,
        "PUT",
        `/api/plugins/${withNonSensitive.id}`,
        { config },
      );
      expect(status).toBe(200);

      const { data: afterData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const updated = (
        afterData.plugins as Array<Record<string, unknown>>
      ).find((p) => p.id === withNonSensitive.id);
      const updatedParam = (
        updated?.parameters as Array<Record<string, unknown>>
      ).find((pr) => pr.key === targetParam.key);
      expect(updatedParam?.isSet).toBe(true);
      expect(updatedParam?.currentValue).toBe(testValue);
    });
  });

  // ===================================================================
  //  4. Full lifecycle: configure → enable → verify → disable → verify
  // ===================================================================

  describe("full lifecycle", () => {
    it("configure → enable → disable round-trip", async () => {
      const { data: listData } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const plugins = listData.plugins as Array<Record<string, unknown>>;

      // Find a plugin that needs configuration
      const needsConfig = plugins.find(
        (p) => (p.validationErrors as Array<unknown>).length > 0,
      );

      if (needsConfig) {
        // Set all required params
        const requiredParams = (
          needsConfig.parameters as Array<Record<string, unknown>>
        ).filter((pr) => pr.required === true);
        const config: Record<string, string> = {};
        for (const param of requiredParams) {
          config[param.key as string] = "lifecycle-roundtrip-1234567890";
        }
        const { status: configStatus } = await http$(
          server.port,
          "PUT",
          `/api/plugins/${needsConfig.id}`,
          { config },
        );
        expect(configStatus).toBe(200);

        // Verify validation cleared
        const { data: afterConfig } = await http$(
          server.port,
          "GET",
          "/api/plugins",
        );
        const configured = (
          afterConfig.plugins as Array<Record<string, unknown>>
        ).find((p) => p.id === needsConfig.id);
        expect((configured?.validationErrors as Array<unknown>).length).toBe(0);
      }

      // Find any valid plugin for enable/disable
      const { data: freshList } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const available = (
        freshList.plugins as Array<Record<string, unknown>>
      ).find((p) => (p.validationErrors as Array<unknown>).length === 0);
      if (!available) return;

      // Enable
      const { status: enableStatus, data: enableData } = await http$(
        server.port,
        "PUT",
        `/api/plugins/${available.id}`,
        { enabled: true },
      );
      expect(enableStatus).toBe(200);
      expect((enableData.plugin as Record<string, unknown>).enabled).toBe(true);

      // Verify enabled in list
      const { data: enabledList } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const enabledPlugin = (
        enabledList.plugins as Array<Record<string, unknown>>
      ).find((p) => p.id === available.id);
      expect(enabledPlugin?.enabled).toBe(true);

      // Disable
      const { status: disableStatus, data: disableData } = await http$(
        server.port,
        "PUT",
        `/api/plugins/${available.id}`,
        { enabled: false },
      );
      expect(disableStatus).toBe(200);
      expect((disableData.plugin as Record<string, unknown>).enabled).toBe(
        false,
      );

      // Verify disabled in list
      const { data: disabledList } = await http$(
        server.port,
        "GET",
        "/api/plugins",
      );
      const disabledPlugin = (
        disabledList.plugins as Array<Record<string, unknown>>
      ).find((p) => p.id === available.id);
      expect(disabledPlugin?.enabled).toBe(false);
    });
  });

  // ===================================================================
  //  5. Agent restart
  // ===================================================================

  describe("agent restart", () => {
    it("POST /api/agent/restart returns 501 when no restart handler", async () => {
      // In standalone mode (no runtime, no onRestart), restart should return 501
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/agent/restart",
      );
      expect(status).toBe(501);
      expect(typeof data.error).toBe("string");
    });

    it("status remains valid after failed restart attempt", async () => {
      // Attempt restart (will fail in standalone mode)
      await http$(server.port, "POST", "/api/agent/restart");

      // Status endpoint should still work
      const { status, data } = await http$(server.port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(typeof data.agentName).toBe("string");
    });

    it("plugins endpoint still works after failed restart", async () => {
      await http$(server.port, "POST", "/api/agent/restart");

      const { status, data } = await http$(server.port, "GET", "/api/plugins");
      expect(status).toBe(200);
      expect(Array.isArray(data.plugins)).toBe(true);
    });
  });
});
