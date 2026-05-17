/**
 * Discriminated result type returned by features that depend on a system
 * permission. Callers branch on `ok`; on failure, `reason` discriminates
 * between a missing permission, a native error, or an unsupported platform.
 */

import type { PermissionId } from "./permissions.js";

export type FeatureResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: "permission";
      permission: PermissionId;
      canRequest: boolean;
    }
  | { ok: false; reason: "native_error"; message: string }
  | { ok: false; reason: "not_supported"; platform: string };
