/**
 * Secret Vault + Credential Route CRUD endpoints.
 *
 * Mount: app.route("/secrets", secretsRoutes)
 *
 * All endpoints require tenant-level authentication.
 * Secret values are NEVER returned in responses.
 *
 * IMPORTANT: Route handlers for /routes/* MUST be registered before /:id
 * handlers to prevent Hono from treating "routes" as a secret ID.
 */

import { SecretVault } from "@stwd/vault";
import { Hono } from "hono";
import {
  type ApiResponse,
  type AppVariables,
  isNonEmptyString,
  MASTER_PASSWORD,
  requireTenantLevel,
  safeJsonParse,
  sanitizeErrorMessage,
} from "../services/context";

export const secretsRoutes = new Hono<{ Variables: AppVariables }>();

// Lazily initialised so context.ts can set MASTER_PASSWORD first
let _secretVault: SecretVault | undefined;
function getSecretVault(): SecretVault {
  _secretVault ??= new SecretVault(MASTER_PASSWORD);
  return _secretVault;
}

// ─── Secret CRUD (collection) ─────────────────────────────────────────────────

/** POST /secrets — create a new secret */
secretsRoutes.post("/", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Secret management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const body = await safeJsonParse<{
    name: string;
    value: string;
    description?: string;
    expiresAt?: string;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(body.name)) {
    return c.json<ApiResponse>({ ok: false, error: "'name' is required" }, 400);
  }

  if (!isNonEmptyString(body.value)) {
    return c.json<ApiResponse>({ ok: false, error: "'value' is required" }, 400);
  }

  try {
    const sv = getSecretVault();
    const secret = await sv.createSecret(tenantId, body.name, body.value, {
      description: body.description,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });
    return c.json<ApiResponse>({ ok: true, data: secret }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("duplicate") || msg.includes("unique")) {
      return c.json<ApiResponse>({ ok: false, error: `Secret "${body.name}" already exists` }, 409);
    }
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

/** GET /secrets — list all secrets (metadata only) */
secretsRoutes.get("/", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Secret management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const sv = getSecretVault();
  const list = await sv.listSecrets(tenantId);
  return c.json<ApiResponse>({ ok: true, data: list });
});

// ─── Route CRUD ───────────────────────────────────────────────────────────────
// NOTE: These MUST be registered before /:id routes to avoid "routes" being
// matched as a secret ID by the dynamic param handler.

/** POST /secrets/routes — create a credential injection route */
secretsRoutes.post("/routes", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Route management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const body = await safeJsonParse<{
    secretId: string;
    hostPattern: string;
    pathPattern?: string;
    method?: string;
    injectAs: string;
    injectKey: string;
    injectFormat?: string;
    priority?: number;
    enabled?: boolean;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(body.secretId)) {
    return c.json<ApiResponse>({ ok: false, error: "'secretId' is required" }, 400);
  }
  if (!isNonEmptyString(body.hostPattern)) {
    return c.json<ApiResponse>({ ok: false, error: "'hostPattern' is required" }, 400);
  }
  if (!isNonEmptyString(body.injectAs)) {
    return c.json<ApiResponse>({ ok: false, error: "'injectAs' is required" }, 400);
  }
  const validInjectAs = ["header", "query", "body"];
  if (!validInjectAs.includes(body.injectAs)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `'injectAs' must be one of: ${validInjectAs.join(", ")}`,
      },
      400,
    );
  }
  if (!isNonEmptyString(body.injectKey)) {
    return c.json<ApiResponse>({ ok: false, error: "'injectKey' is required" }, 400);
  }

  try {
    const sv = getSecretVault();
    const route = await sv.createRoute(tenantId, body.secretId, {
      hostPattern: body.hostPattern,
      pathPattern: body.pathPattern,
      method: body.method,
      injectAs: body.injectAs,
      injectKey: body.injectKey,
      injectFormat: body.injectFormat,
      priority: body.priority,
      enabled: body.enabled,
    });
    return c.json<ApiResponse>({ ok: true, data: route }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("not found")) {
      return c.json<ApiResponse>({ ok: false, error: msg }, 404);
    }
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

/** GET /secrets/routes — list all routes */
secretsRoutes.get("/routes", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Route management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const sv = getSecretVault();
  const routes = await sv.listRoutes(tenantId);
  return c.json<ApiResponse>({ ok: true, data: routes });
});

/** PUT /secrets/routes/:id — update route */
secretsRoutes.put("/routes/:id", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Route management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const routeId = c.req.param("id");
  const body = await safeJsonParse<{
    hostPattern?: string;
    pathPattern?: string;
    method?: string;
    injectAs?: string;
    injectKey?: string;
    injectFormat?: string;
    priority?: number;
    enabled?: boolean;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (body.injectAs) {
    const validInjectAs = ["header", "query", "body"];
    if (!validInjectAs.includes(body.injectAs)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `'injectAs' must be one of: ${validInjectAs.join(", ")}`,
        },
        400,
      );
    }
  }

  const sv = getSecretVault();
  const updated = await sv.updateRoute(tenantId, routeId, body);

  if (!updated) {
    return c.json<ApiResponse>({ ok: false, error: "Route not found" }, 404);
  }

  return c.json<ApiResponse>({ ok: true, data: updated });
});

/** DELETE /secrets/routes/:id — delete route */
secretsRoutes.delete("/routes/:id", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Route management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const routeId = c.req.param("id");
  const sv = getSecretVault();
  const deleted = await sv.deleteRoute(tenantId, routeId);

  if (!deleted) {
    return c.json<ApiResponse>({ ok: false, error: "Route not found" }, 404);
  }

  return c.json<ApiResponse>({ ok: true, data: { deleted: routeId } });
});

// ─── Secret CRUD (by ID) ──────────────────────────────────────────────────────
// NOTE: These /:id handlers are registered AFTER /routes/* to avoid swallowing
// the literal path segment "routes" as a dynamic param.

/** GET /secrets/:id — get secret metadata */
secretsRoutes.get("/:id", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Secret management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const secretId = c.req.param("id");
  const sv = getSecretVault();
  const secret = await sv.getSecretById(tenantId, secretId);

  if (!secret) {
    return c.json<ApiResponse>({ ok: false, error: "Secret not found" }, 404);
  }

  return c.json<ApiResponse>({ ok: true, data: secret });
});

/** PUT /secrets/:id — update secret value (creates new version) */
secretsRoutes.put("/:id", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Secret management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const secretId = c.req.param("id");
  const body = await safeJsonParse<{ value: string }>(c);

  if (!body || !isNonEmptyString(body.value)) {
    return c.json<ApiResponse>({ ok: false, error: "'value' is required" }, 400);
  }

  const sv = getSecretVault();
  const existing = await sv.getSecretById(tenantId, secretId);
  if (!existing) {
    return c.json<ApiResponse>({ ok: false, error: "Secret not found" }, 404);
  }

  try {
    const rotated = await sv.rotateSecret(tenantId, existing.name, body.value);
    return c.json<ApiResponse>({ ok: true, data: rotated });
  } catch (e: unknown) {
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});

/** DELETE /secrets/:id — soft delete */
secretsRoutes.delete("/:id", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Secret management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const secretId = c.req.param("id");
  const sv = getSecretVault();
  const deleted = await sv.deleteSecret(tenantId, secretId);

  if (!deleted) {
    return c.json<ApiResponse>({ ok: false, error: "Secret not found" }, 404);
  }

  return c.json<ApiResponse>({ ok: true, data: { deleted: secretId } });
});

/** POST /secrets/:id/rotate — rotate with new value */
secretsRoutes.post("/:id/rotate", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Secret management requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const secretId = c.req.param("id");
  const body = await safeJsonParse<{ value: string }>(c);

  if (!body || !isNonEmptyString(body.value)) {
    return c.json<ApiResponse>({ ok: false, error: "'value' is required" }, 400);
  }

  const sv = getSecretVault();
  const existing = await sv.getSecretById(tenantId, secretId);
  if (!existing) {
    return c.json<ApiResponse>({ ok: false, error: "Secret not found" }, 404);
  }

  try {
    const rotated = await sv.rotateSecret(tenantId, existing.name, body.value);
    return c.json<ApiResponse>({ ok: true, data: rotated });
  } catch (e: unknown) {
    return c.json<ApiResponse>({ ok: false, error: sanitizeErrorMessage(e) }, 500);
  }
});
