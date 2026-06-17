/**
 * Keyless real-runtime HTTP coverage for the permissions routes and the local
 * sensitive-request routes.
 *
 * Boots a REAL AgentRuntime + the REAL app-core HTTP stack via
 * {@link startLiveRuntimeServer}, then drives both surfaces over real HTTP. No
 * provider keys: neither surface calls a model. Loopback requests are trusted
 * (no token / cloud-provisioned env), so writes authorize without credentials.
 *
 * Permissions — packages/agent/src/api/permissions-routes.ts:
 *   - GET  /api/permissions        :361 → PermissionId → PermissionState map (+ _platform, _shellEnabled)
 *   - GET  /api/permissions/:id     :390 → single PermissionState
 *   - PUT  /api/permissions/state   :551 → { permissions?: Record<id, PermissionState>, startup? }
 *                                          (PutPermissionsStateRequestSchema) → { updated: true, permissions }
 *   PermissionState required fields (validatePermissionStates :146): id (== key), status, platform,
 *   lastChecked (number), canRequest (boolean). PERMISSION_IDS include "notifications".
 *
 * Sensitive requests — packages/app-core/src/api/sensitive-request-routes.ts:
 *   - POST /api/sensitive-requests        :478 → 201 { ok, request, submitToken, submit }
 *   - GET  /api/sensitive-requests/:id     :551 → 200 { ok, request }
 *   A `secret` target with source "api" and no cloud/tunnel resolves to delivery
 *   mode "dm_or_owner_app_instruction" (sensitive-request-policy.ts), so the
 *   tunnel-auth 403 gate is not hit and create/get succeed keyless.
 *
 * NOTE (judgment call): the sensitive-request API exposes create (POST) and
 * fetch-by-id (GET /:id) only — there is no list endpoint — so the lifecycle
 * asserted here is create → fetch-by-id rather than create → list.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { req } from "../helpers/http.ts";
import {
  type RuntimeHarness,
  startLiveRuntimeServer,
} from "../helpers/live-runtime-server.ts";

describe("permissions + sensitive-request real coverage", () => {
  let harness: RuntimeHarness | null = null;

  beforeAll(async () => {
    harness = await startLiveRuntimeServer({
      tempPrefix: "permissions-sensitive-",
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  function port(): number {
    if (!harness) {
      throw new Error("Live runtime harness was not started");
    }
    return harness.port;
  }

  it("GET /api/permissions returns the permission map with platform metadata", async () => {
    const { status, data } = await req(port(), "GET", "/api/permissions");
    expect(status).toBe(200);
    expect(typeof data._platform).toBe("string");
    expect(typeof data._shellEnabled).toBe("boolean");
    // Every entry is keyed by a permission id and carries a real status.
    const notifications = data.notifications as
      | { id: string; status: string }
      | undefined;
    expect(notifications).toBeDefined();
    expect(notifications?.id).toBe("notifications");
    expect(typeof notifications?.status).toBe("string");
  });

  it("PUT /api/permissions/state persists a permission set and GET reflects it", async () => {
    const now = Date.now();
    const put = await req(port(), "PUT", "/api/permissions/state", {
      // `startup` keeps the runtime from scheduling a restart on capability
      // auto-enable, which keeps the live harness stable for the rest of the run.
      startup: true,
      permissions: {
        notifications: {
          id: "notifications",
          status: "granted",
          platform: "linux",
          lastChecked: now,
          canRequest: false,
        },
      },
    });
    expect(put.status).toBe(200);
    expect(put.data.updated).toBe(true);
    const persisted = (
      put.data.permissions as Record<string, { status: string }>
    ).notifications;
    expect(persisted.status).toBe("granted");

    // GET /api/permissions/:id returns the persisted state.
    const get = await req(port(), "GET", "/api/permissions/notifications");
    expect(get.status).toBe(200);
    expect(get.data.id).toBe("notifications");
    expect(get.data.status).toBe("granted");
    expect(get.data.lastChecked).toBe(now);
  });

  it("PUT /api/permissions/state rejects an unknown permission id", async () => {
    const put = await req(port(), "PUT", "/api/permissions/state", {
      startup: true,
      permissions: {
        "not-a-real-permission": {
          id: "not-a-real-permission",
          status: "granted",
          platform: "linux",
          lastChecked: Date.now(),
          canRequest: false,
        },
      },
    });
    expect(put.status).toBe(400);
  });

  it("POST /api/sensitive-requests creates a secret request that is fetchable by id", async () => {
    const create = await req(port(), "POST", "/api/sensitive-requests", {
      kind: "secret",
      agentId: "live-test-agent",
      source: "api",
      target: { kind: "secret", key: "live_test_secret_key" },
    });
    expect(create.status).toBe(201);
    expect(create.data.ok).toBe(true);
    expect(typeof create.data.submitToken).toBe("string");
    const request = create.data.request as { id: string; kind: string };
    expect(typeof request.id).toBe("string");
    expect(request.id.length).toBeGreaterThan(0);
    expect(request.kind).toBe("secret");
    const submit = create.data.submit as {
      method: string;
      tokenRequired: boolean;
    };
    expect(submit.method).toBe("POST");
    expect(submit.tokenRequired).toBe(true);

    // GET /api/sensitive-requests/:id retrieves the same (redacted) record.
    const fetched = await req(
      port(),
      "GET",
      `/api/sensitive-requests/${encodeURIComponent(request.id)}`,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.data.ok).toBe(true);
    const fetchedRequest = fetched.data.request as { id: string; kind: string };
    expect(fetchedRequest.id).toBe(request.id);
    expect(fetchedRequest.kind).toBe("secret");

    // A missing id returns 404.
    const missing = await req(
      port(),
      "GET",
      "/api/sensitive-requests/does-not-exist",
    );
    expect(missing.status).toBe(404);
  });
});
