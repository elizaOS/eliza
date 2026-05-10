/**
 * Vault inventory + profile + routing API routes.
 *
 *   GET    /api/secrets/inventory                   → VaultEntryMeta[]
 *                                                    (no values; loopback gate only — list is meta)
 *   GET    /api/secrets/inventory/:key              → reveal active-profile value
 *                                                    (sensitive → ensureCompatSensitiveRouteAuthorized)
 *   PUT    /api/secrets/inventory/:key              → upsert { value, label?, providerId?, category? }
 *                                                    (sensitive)
 *   DELETE /api/secrets/inventory/:key              → drop key + meta + every profile
 *                                                    (sensitive)
 *
 *   GET    /api/secrets/inventory/:key/profiles     → profile list (no values)
 *                                                    (loopback)
 *   POST   /api/secrets/inventory/:key/profiles     → add { id, label, value }
 *                                                    (sensitive)
 *   PATCH  /api/secrets/inventory/:key/profiles/:id → update { label?, value? }
 *                                                    (sensitive)
 *   DELETE /api/secrets/inventory/:key/profiles/:id → drop profile
 *                                                    (sensitive)
 *   PUT    /api/secrets/inventory/:key/active-profile → { profileId }
 *                                                    (sensitive)
 *
 *   GET    /api/secrets/routing                     → RoutingConfig
 *   PUT    /api/secrets/routing                     → save RoutingConfig
 *                                                    (sensitive — names internal config)
 *
 *   POST   /api/secrets/inventory/migrate-to-profiles
 *                                                    → opt-in: copy plain `<KEY>` value
 *                                                       into `<KEY>.profile.default` and write
 *                                                       _meta.<KEY>. Idempotent.
 *
 * The "sensitive" gate matches `PUT /api/secrets/manager/preferences`:
 * loopback-from-this-machine OR a configured compat API token. We do
 * not loosen that boundary.
 */

import type http from "node:http";
import {
  listVaultInventory,
  profileStorageKey,
  ROUTING_KEY,
  readEntryMeta,
  readRoutingConfig,
  removeEntryMeta,
  setEntryMeta,
  type VaultEntryCategory,
  type VaultEntryMeta,
  type VaultEntryMetaUpdate,
  type VaultEntryProfile,
  writeRoutingConfig,
} from "@elizaos/vault";
import { sharedVault } from "../services/vault-mirror";
import { ensureCompatSensitiveRouteAuthorized } from "./auth.ts";
import { sendJson, sendJsonError } from "./response";

// ── Public dispatcher ──────────────────────────────────────────────

const KEY_RE = /^[A-Za-z0-9_.-]+$/;
const PROFILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const CATEGORY_VALUES: ReadonlySet<VaultEntryCategory> = new Set([
  "provider",
  "plugin",
  "wallet",
  "credential",
  "system",
  "session",
]);

// Internal/reserved keys that the inventory layer manages itself —
// they must never be surfaced through these routes (read or written).
function isReservedKey(key: string): boolean {
  return (
    key.startsWith("_meta.") ||
    key.startsWith("_manager.") ||
    key === ROUTING_KEY
  );
}

export async function handleSecretsInventoryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (
    !pathname.startsWith("/api/secrets/inventory") &&
    !pathname.startsWith("/api/secrets/routing")
  ) {
    return false;
  }

  // Routing config endpoints.
  if (pathname === "/api/secrets/routing") {
    if (method === "GET") {
      const vault = sharedVault();
      const config = await readRoutingConfig(vault);
      sendJson(res, 200, { ok: true, config });
      return true;
    }
    if (method === "PUT") {
      if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
      const body = await readJsonBody(req);
      if (body === null) {
        sendJsonError(res, 400, "invalid JSON body");
        return true;
      }
      const config = (body as { config?: unknown }).config;
      if (!config || typeof config !== "object") {
        sendJsonError(res, 400, "missing `config` field");
        return true;
      }
      const vault = sharedVault();
      await writeRoutingConfig(
        vault,
        config as Parameters<typeof writeRoutingConfig>[1],
      );
      const saved = await readRoutingConfig(vault);
      sendJson(res, 200, { ok: true, config: saved });
      return true;
    }
    sendJsonError(res, 405, "method not allowed");
    return true;
  }

  // Migrate-to-profiles endpoint (POST only).
  if (pathname === "/api/secrets/inventory/migrate-to-profiles") {
    if (method !== "POST") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const body = (await readJsonBody(req)) as { key?: unknown } | null;
    const targetKey = typeof body?.key === "string" ? body.key : null;
    if (!targetKey || !KEY_RE.test(targetKey) || isReservedKey(targetKey)) {
      sendJsonError(res, 400, "invalid `key`");
      return true;
    }
    const result = await migrateKeyToProfiles(targetKey);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  // Top-level inventory list. Optional `?category=<value>` narrows the
  // response to entries whose computed category matches — used by the
  // Settings -> Wallet & RPC section so it can pull wallet keys without
  // re-implementing the listing logic. Unknown / malformed categories
  // get a 400 instead of silently returning the full list.
  if (pathname === "/api/secrets/inventory") {
    if (method !== "GET") {
      sendJsonError(res, 405, "method not allowed");
      return true;
    }
    const url = new URL(req.url ?? "", "http://localhost");
    const categoryParam = url.searchParams.get("category");
    if (
      categoryParam !== null &&
      !CATEGORY_VALUES.has(categoryParam as VaultEntryCategory)
    ) {
      sendJsonError(res, 400, "`category` must be a known VaultEntryCategory");
      return true;
    }
    const vault = sharedVault();
    const all = await listVaultInventory(vault);
    const entries = categoryParam
      ? all.filter((e) => e.category === categoryParam)
      : all;
    sendJson(res, 200, { ok: true, entries: entries as VaultEntryMeta[] });
    return true;
  }

  // /api/secrets/inventory/<key>[/...]
  const inventoryPathRe = /^\/api\/secrets\/inventory\/(.+)$/;
  const match = inventoryPathRe.exec(pathname);
  if (!match) return false;
  const tail = match[1] ?? "";
  // Sub-path parsing. Order matters: most specific first.
  // /<key>/profiles/<id>
  const profileIdRe = /^([^/]+)\/profiles\/([^/]+)$/;
  // /<key>/profiles
  const profilesRe = /^([^/]+)\/profiles$/;
  // /<key>/active-profile
  const activeProfileRe = /^([^/]+)\/active-profile$/;

  let key: string | null = null;
  let profileId: string | null = null;
  let segment: "key" | "profiles" | "profile" | "active-profile" = "key";

  const profileIdMatch = profileIdRe.exec(tail);
  const profilesMatch = profilesRe.exec(tail);
  const activeProfileMatch = activeProfileRe.exec(tail);

  if (profileIdMatch) {
    key = decodeURIComponent(profileIdMatch[1] ?? "");
    profileId = decodeURIComponent(profileIdMatch[2] ?? "");
    segment = "profile";
  } else if (profilesMatch) {
    key = decodeURIComponent(profilesMatch[1] ?? "");
    segment = "profiles";
  } else if (activeProfileMatch) {
    key = decodeURIComponent(activeProfileMatch[1] ?? "");
    segment = "active-profile";
  } else if (!tail.includes("/")) {
    key = decodeURIComponent(tail);
    segment = "key";
  } else {
    return false;
  }

  if (!key || !KEY_RE.test(key) || isReservedKey(key)) {
    sendJsonError(res, 400, "invalid `key`");
    return true;
  }
  if (profileId !== null && !PROFILE_ID_RE.test(profileId)) {
    sendJsonError(res, 400, "invalid `profileId`");
    return true;
  }

  if (segment === "key") {
    return handleKeyRoute(req, res, method, key);
  }
  if (segment === "profiles") {
    return handleProfilesRoute(req, res, method, key);
  }
  if (segment === "profile") {
    if (profileId === null) {
      sendJsonError(res, 400, "missing `profileId`");
      return true;
    }
    return handleSingleProfileRoute(req, res, method, key, profileId);
  }
  return handleActiveProfileRoute(req, res, method, key);
}

// ── Key-level handlers ─────────────────────────────────────────────

async function handleKeyRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  key: string,
): Promise<boolean> {
  const vault = sharedVault();

  if (method === "GET") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const meta = await readEntryMeta(vault, key);
    if (meta?.activeProfile) {
      const profileKey = profileStorageKey(key, meta.activeProfile);
      if (await vault.has(profileKey)) {
        sendJson(res, 200, {
          ok: true,
          value: await vault.reveal(profileKey, "inventory-routes"),
          source: "profile",
          profileId: meta.activeProfile,
        });
        return true;
      }
    }
    if (!(await vault.has(key))) {
      sendJsonError(res, 404, "no entry for key");
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      value: await vault.reveal(key, "inventory-routes"),
      source: "bare",
    });
    return true;
  }

  if (method === "PUT") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const body = await readJsonBody(req);
    if (body === null) {
      sendJsonError(res, 400, "invalid JSON body");
      return true;
    }
    const v = body as {
      value?: unknown;
      label?: unknown;
      providerId?: unknown;
      category?: unknown;
    };
    if (typeof v.value !== "string" || v.value.length === 0) {
      sendJsonError(res, 400, "`value` is required");
      return true;
    }
    if (v.label !== undefined && typeof v.label !== "string") {
      sendJsonError(res, 400, "`label` must be string when set");
      return true;
    }
    if (v.providerId !== undefined && typeof v.providerId !== "string") {
      sendJsonError(res, 400, "`providerId` must be string when set");
      return true;
    }
    if (
      v.category !== undefined &&
      (typeof v.category !== "string" ||
        !CATEGORY_VALUES.has(v.category as VaultEntryCategory))
    ) {
      sendJsonError(res, 400, "`category` must be a known VaultEntryCategory");
      return true;
    }
    await vault.set(key, v.value, {
      sensitive: true,
      caller: "inventory-routes",
    });
    // Build a writable update so we can conditionally include only the
    // user-supplied fields. The setEntryMeta payload type is readonly;
    // we materialize a mutable record locally and cast at the call site.
    const metaPartial: {
      label?: string;
      providerId?: string;
      category?: VaultEntryCategory;
    } = {};
    if (typeof v.label === "string") metaPartial.label = v.label;
    if (typeof v.providerId === "string") metaPartial.providerId = v.providerId;
    if (typeof v.category === "string") {
      metaPartial.category = v.category as VaultEntryCategory;
    }
    if (Object.keys(metaPartial).length > 0) {
      await setEntryMeta(vault, key, metaPartial as VaultEntryMetaUpdate);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === "DELETE") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    if (await vault.has(key)) await vault.remove(key);
    // Drop every profile child too. `vault.list` matches segment-prefixed
    // keys, so this catches `<KEY>.profile.default`, `<KEY>.profile.work`,
    // etc.
    const all = await vault.list(key);
    for (const k of all) {
      if (k === key) continue;
      if (k.startsWith(`${key}.profile.`)) {
        await vault.remove(k);
      }
    }
    await removeEntryMeta(vault, key);
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJsonError(res, 405, "method not allowed");
  return true;
}

// ── Profiles handlers ─────────────────────────────────────────────

async function handleProfilesRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  key: string,
): Promise<boolean> {
  const vault = sharedVault();

  if (method === "GET") {
    const meta = await readEntryMeta(vault, key);
    sendJson(res, 200, {
      ok: true,
      profiles: (meta?.profiles ?? []) as VaultEntryProfile[],
      activeProfile: meta?.activeProfile ?? null,
    });
    return true;
  }

  if (method === "POST") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const body = await readJsonBody(req);
    if (body === null) {
      sendJsonError(res, 400, "invalid JSON body");
      return true;
    }
    const v = body as { id?: unknown; label?: unknown; value?: unknown };
    if (typeof v.id !== "string" || !PROFILE_ID_RE.test(v.id)) {
      sendJsonError(res, 400, "`id` must match [A-Za-z0-9_-]+");
      return true;
    }
    if (typeof v.value !== "string" || v.value.length === 0) {
      sendJsonError(res, 400, "`value` is required");
      return true;
    }
    const label =
      typeof v.label === "string" && v.label.length > 0 ? v.label : v.id;

    const meta = await readEntryMeta(vault, key);
    const profiles = (meta?.profiles ?? []).slice();
    if (profiles.some((p) => p.id === v.id)) {
      sendJsonError(res, 409, "profile id already exists");
      return true;
    }
    profiles.push({ id: v.id, label, createdAt: Date.now() });
    await vault.set(profileStorageKey(key, v.id), v.value, {
      sensitive: true,
      caller: "inventory-routes",
    });
    await setEntryMeta(vault, key, {
      profiles,
      // First profile added auto-becomes the active profile so the user
      // doesn't end up with profiles defined but none active. Existing
      // active profile is preserved.
      ...(meta?.activeProfile ? {} : { activeProfile: v.id }),
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJsonError(res, 405, "method not allowed");
  return true;
}

async function handleSingleProfileRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  key: string,
  profileId: string,
): Promise<boolean> {
  const vault = sharedVault();

  if (method === "PATCH") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const body = await readJsonBody(req);
    if (body === null) {
      sendJsonError(res, 400, "invalid JSON body");
      return true;
    }
    const v = body as { label?: unknown; value?: unknown };
    if (v.label !== undefined && typeof v.label !== "string") {
      sendJsonError(res, 400, "`label` must be string when set");
      return true;
    }
    if (
      v.value !== undefined &&
      (typeof v.value !== "string" || v.value.length === 0)
    ) {
      sendJsonError(res, 400, "`value` must be a non-empty string when set");
      return true;
    }
    const meta = await readEntryMeta(vault, key);
    const profiles = (meta?.profiles ?? []).slice();
    const idx = profiles.findIndex((p) => p.id === profileId);
    if (idx < 0) {
      sendJsonError(res, 404, "no such profile");
      return true;
    }
    if (typeof v.value === "string") {
      await vault.set(profileStorageKey(key, profileId), v.value, {
        sensitive: true,
        caller: "inventory-routes",
      });
    }
    if (typeof v.label === "string") {
      const existing = profiles[idx];
      if (!existing) {
        sendJsonError(res, 404, "no such profile");
        return true;
      }
      profiles[idx] = { ...existing, label: v.label };
      await setEntryMeta(vault, key, { profiles });
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === "DELETE") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    const meta = await readEntryMeta(vault, key);
    const profiles = (meta?.profiles ?? []).slice();
    const idx = profiles.findIndex((p) => p.id === profileId);
    if (idx < 0) {
      sendJsonError(res, 404, "no such profile");
      return true;
    }
    profiles.splice(idx, 1);
    const profileKey = profileStorageKey(key, profileId);
    if (await vault.has(profileKey)) await vault.remove(profileKey);
    const activeProfile =
      meta?.activeProfile === profileId
        ? (profiles[0]?.id ?? null)
        : (meta?.activeProfile ?? null);
    await setEntryMeta(vault, key, {
      profiles: profiles.length > 0 ? profiles : null,
      activeProfile: activeProfile === null ? null : activeProfile,
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJsonError(res, 405, "method not allowed");
  return true;
}

async function handleActiveProfileRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  key: string,
): Promise<boolean> {
  if (method !== "PUT") {
    sendJsonError(res, 405, "method not allowed");
    return true;
  }
  if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
  const body = await readJsonBody(req);
  if (body === null) {
    sendJsonError(res, 400, "invalid JSON body");
    return true;
  }
  const v = body as { profileId?: unknown };
  if (typeof v.profileId !== "string" || !PROFILE_ID_RE.test(v.profileId)) {
    sendJsonError(res, 400, "`profileId` is required");
    return true;
  }
  const vault = sharedVault();
  const meta = await readEntryMeta(vault, key);
  const profiles = meta?.profiles ?? [];
  if (!profiles.some((p) => p.id === v.profileId)) {
    sendJsonError(res, 404, "profile id not found for key");
    return true;
  }
  await setEntryMeta(vault, key, { activeProfile: v.profileId });
  sendJson(res, 200, { ok: true });
  return true;
}

// ── Migration ──────────────────────────────────────────────────────

interface MigrationResult {
  readonly migrated: boolean;
  readonly profileId?: string;
  readonly reason?: string;
}

async function migrateKeyToProfiles(key: string): Promise<MigrationResult> {
  const vault = sharedVault();
  const existingMeta = await readEntryMeta(vault, key);
  if (existingMeta?.profiles?.length) {
    return { migrated: false, reason: "already-has-profiles" };
  }
  if (!(await vault.has(key))) {
    return { migrated: false, reason: "key-not-found" };
  }
  const value = await vault.reveal(key, "inventory-migrate");
  await vault.set(profileStorageKey(key, "default"), value, {
    sensitive: true,
    caller: "inventory-migrate",
  });
  await setEntryMeta(vault, key, {
    profiles: [{ id: "default", label: "Default", createdAt: Date.now() }],
    activeProfile: "default",
  });
  return { migrated: true, profileId: "default" };
}

// ── Helpers ─────────────────────────────────────────────────────────

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<unknown | null> {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
