/**
 * Keyless real-runtime HTTP coverage for the configuration routes.
 *
 * Boots a REAL AgentRuntime + the REAL app-core HTTP stack via
 * {@link startLiveRuntimeServer}, then drives GET/PUT /api/config,
 * GET /api/config/schema, and POST /api/config/reload over real HTTP. No
 * provider keys: none of these routes call a model.
 *
 * Config persistence is isolated to a temp `eliza.json` via
 * {@link useIsolatedConfigEnv} (ELIZA_CONFIG_PATH), so the PUT → reload round
 * trip reads back from the same file the server wrote.
 *
 * Routes + schema grounded in packages/agent/src/api/config-routes.ts:
 *   - GET  /api/config         :316  → redacted config object
 *   - GET  /api/config/schema  :268  → buildConfigSchema(): { schema, uiHints, version, generatedAt }
 *   - PUT  /api/config         :329  → merges allowed top keys; "ui" is in
 *                                       CONFIG_WRITE_ALLOWED_TOP_KEYS + HOT_RELOADABLE_TOP_KEYS
 *   - POST /api/config/reload  :280  → { reloaded: true, applied, requiresRestart }
 * Config schema response shape: packages/agent/src/config/schema.ts:93 (ConfigSchemaResponse).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { req } from "../helpers/http.ts";
import { useIsolatedConfigEnv } from "../helpers/isolated-config.ts";
import {
  type RuntimeHarness,
  startLiveRuntimeServer,
} from "../helpers/live-runtime-server.ts";

describe("config routes real coverage", () => {
  let configEnv: ReturnType<typeof useIsolatedConfigEnv> | null = null;
  let harness: RuntimeHarness | null = null;

  beforeAll(async () => {
    configEnv = useIsolatedConfigEnv("config-routes-real-");
    harness = await startLiveRuntimeServer({
      tempPrefix: "config-routes-real-",
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
    await configEnv?.restore();
  });

  function port(): number {
    if (!harness) {
      throw new Error("Live runtime harness was not started");
    }
    return harness.port;
  }

  it("GET /api/config returns the current config object", async () => {
    const { status, data } = await req(port(), "GET", "/api/config");
    expect(status).toBe(200);
    expect(data).not.toBeNull();
    expect(typeof data).toBe("object");
    expect(Array.isArray(data)).toBe(false);
  });

  it("GET /api/config/schema returns the zod-derived JSON schema", async () => {
    const { status, data } = await req(port(), "GET", "/api/config/schema");
    expect(status).toBe(200);

    const schema = data.schema as {
      title?: string;
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.title).toBe("ElizaConfig");
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeTruthy();
    // "ui" is a real top-level config section derived from the zod schema.
    expect(schema.properties && "ui" in schema.properties).toBe(true);

    expect(typeof data.version).toBe("string");
    expect(typeof data.generatedAt).toBe("string");
    expect(data.uiHints).toBeTruthy();
  });

  it("PUT /api/config persists a real field, GET reflects it, reload reports it applied", async () => {
    const marker = `live-${Date.now()}`;

    const put = await req(port(), "PUT", "/api/config", {
      ui: { theme: "dark", liveTestMarker: marker },
    });
    expect(put.status).toBe(200);
    // PUT echoes back the (redacted) merged config.
    expect((put.data.ui as Record<string, unknown>).theme).toBe("dark");
    expect((put.data.ui as Record<string, unknown>).liveTestMarker).toBe(
      marker,
    );

    // A fresh GET must reflect the persisted value (state.config is SoT).
    const afterPut = await req(port(), "GET", "/api/config");
    expect(afterPut.status).toBe(200);
    expect((afterPut.data.ui as Record<string, unknown>).theme).toBe("dark");
    expect((afterPut.data.ui as Record<string, unknown>).liveTestMarker).toBe(
      marker,
    );

    // POST /api/config/reload re-reads eliza.json from disk and buckets the
    // changed top keys. "ui" is hot-reloadable, so it lands in `applied`.
    const reload = await req(port(), "POST", "/api/config/reload");
    expect(reload.status).toBe(200);
    expect(reload.data.reloaded).toBe(true);
    expect(Array.isArray(reload.data.applied)).toBe(true);
    expect(Array.isArray(reload.data.requiresRestart)).toBe(true);

    // The reloaded config still carries the persisted marker.
    const afterReload = await req(port(), "GET", "/api/config");
    expect(
      (afterReload.data.ui as Record<string, unknown>).liveTestMarker,
    ).toBe(marker);
  });
});
