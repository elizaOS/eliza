/**
 * Parser and types for the `elizaos.app.permissions` manifest block declared
 * by third-party apps in their `package.json`. Spec lives at
 * `eliza/packages/docs/architecture/app-permissions-manifest.md` and is the
 * source of truth — this module implements the validation rules described
 * there. The manifest is advisory in this slice (no enforcement).
 *
 * Forward compatibility: only the recognised namespaces (`fs`, `net`) are
 * validated and surfaced as typed slices. Unrecognised keys inside the
 * `permissions` object are preserved verbatim under `raw` so a future
 * Milady version that recognises them can read them out of the persisted
 * registry without re-parsing the source manifest.
 *
 * NOTE: this module is distinct from `./permissions.ts`, which describes
 * OS-level system permissions (camera, microphone, accessibility). App
 * permissions are an in-runtime sandbox concept declared by an app's
 * package.json; system permissions are an OS concept granted to the
 * Milady binary itself.
 */

export const MAX_PATTERN_LENGTH = 256;

/**
 * Namespaces this Milady version recognises in `elizaos.app.permissions`.
 * The parser surfaces only these as typed slices; other namespace keys
 * declared by an app are preserved verbatim under `raw` for forward
 * compatibility but cannot be granted (a future Milady version that
 * recognises them adds them here).
 *
 * Source of truth for the granted-permission store's namespace
 * intersection — see
 * `eliza/packages/docs/architecture/app-permissions-granted-store.md`.
 */
export const RECOGNISED_PERMISSION_NAMESPACES = ["fs", "net"] as const;
export type RecognisedPermissionNamespace =
  (typeof RECOGNISED_PERMISSION_NAMESPACES)[number];

/**
 * Returns the recognised namespaces actually declared by a parsed
 * manifest. This is what a consent UI should render as toggleable rows.
 */
export function recognisedNamespacesFor(
  manifest: AppPermissionsManifest,
): RecognisedPermissionNamespace[] {
  const out: RecognisedPermissionNamespace[] = [];
  if (manifest.fs !== undefined) out.push("fs");
  if (manifest.net !== undefined) out.push("net");
  return out;
}

/**
 * Returns the recognised namespaces actually declared by a raw
 * `requestedPermissions` object as persisted on `AppRegistryEntry`.
 * Equivalent to `recognisedNamespacesFor(parseAppPermissions(raw))`
 * when the raw shape is well-formed, but tolerant of malformed
 * persisted state (returns `[]` rather than throwing).
 */
export function recognisedNamespacesForRaw(
  raw: Record<string, unknown> | null | undefined,
): RecognisedPermissionNamespace[] {
  if (!raw) return [];
  const result = parseAppPermissions(raw);
  if (result.ok === false) return [];
  return recognisedNamespacesFor(result.manifest);
}

export interface FsPermissions {
  read?: string[];
  write?: string[];
}

export interface NetPermissions {
  outbound?: string[];
}

export interface AppPermissionsManifest {
  /**
   * Raw declared object as it appears under `elizaos.app.permissions`,
   * or `null` when no `permissions` block was declared. This is what
   * persists into `app-registry.json` and the audit log so future
   * Milady versions can read namespaces this version did not validate.
   */
  raw: Record<string, unknown> | null;
  fs?: FsPermissions;
  net?: NetPermissions;
}

export interface ParseAppPermissionsError {
  ok: false;
  reason: string;
  path: string;
}

export type ParseAppPermissionsResult =
  | { ok: true; manifest: AppPermissionsManifest }
  | ParseAppPermissionsError;

type StringArraySuccess = { ok: true; value: string[] | null };
type FsSuccess = { ok: true; value: FsPermissions | null };
type NetSuccess = { ok: true; value: NetPermissions | null };

export function parseAppPermissions(value: unknown): ParseAppPermissionsResult {
  if (value === undefined || value === null) {
    return { ok: true, manifest: { raw: null } };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      reason: "permissions must be an object",
      path: "permissions",
    };
  }
  const raw = value as Record<string, unknown>;
  const manifest: AppPermissionsManifest = { raw };

  if ("fs" in raw) {
    const fsResult = parseFs(raw.fs, "permissions.fs");
    if (fsResult.ok === false) return fsResult;
    if (fsResult.value !== null) manifest.fs = fsResult.value;
  }

  if ("net" in raw) {
    const netResult = parseNet(raw.net, "permissions.net");
    if (netResult.ok === false) return netResult;
    if (netResult.value !== null) manifest.net = netResult.value;
  }

  return { ok: true, manifest };
}

function parseFs(
  value: unknown,
  basePath: string,
): FsSuccess | ParseAppPermissionsError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "fs must be an object", path: basePath };
  }
  const obj = value as Record<string, unknown>;
  const out: FsPermissions = {};

  if ("read" in obj) {
    const readResult = parseStringArray(
      obj.read,
      `${basePath}.read`,
      "fs.read must be an array of glob strings",
    );
    if (readResult.ok === false) return readResult;
    if (readResult.value !== null) out.read = readResult.value;
  }

  if ("write" in obj) {
    const writeResult = parseStringArray(
      obj.write,
      `${basePath}.write`,
      "fs.write must be an array of glob strings",
    );
    if (writeResult.ok === false) return writeResult;
    if (writeResult.value !== null) out.write = writeResult.value;
  }

  return { ok: true, value: hasOwnKeys(out) ? out : null };
}

function parseNet(
  value: unknown,
  basePath: string,
): NetSuccess | ParseAppPermissionsError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "net must be an object", path: basePath };
  }
  const obj = value as Record<string, unknown>;
  const out: NetPermissions = {};

  if ("outbound" in obj) {
    const outboundResult = parseStringArray(
      obj.outbound,
      `${basePath}.outbound`,
      "net.outbound must be an array of host pattern strings",
    );
    if (outboundResult.ok === false) return outboundResult;
    if (outboundResult.value !== null) out.outbound = outboundResult.value;
  }

  return { ok: true, value: hasOwnKeys(out) ? out : null };
}

function parseStringArray(
  value: unknown,
  basePath: string,
  shapeError: string,
): StringArraySuccess | ParseAppPermissionsError {
  if (value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value)) {
    return { ok: false, reason: shapeError, path: basePath };
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string") {
      return { ok: false, reason: shapeError, path: `${basePath}[${i}]` };
    }
    if (item.length > MAX_PATTERN_LENGTH) {
      return {
        ok: false,
        reason: `${basePath}[${i}] exceeds ${MAX_PATTERN_LENGTH} characters`,
        path: `${basePath}[${i}]`,
      };
    }
  }
  return { ok: true, value: value as string[] };
}

function hasOwnKeys(obj: object): boolean {
  for (const _ in obj) return true;
  return false;
}
