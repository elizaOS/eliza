/**
 * Delete channel for the durable cloud-pair API token (#16666).
 *
 * `persistCloudPairApiToken` (CloudPairRelay) writes the key into BOTH
 * sessionStorage and localStorage so an installed PWA survives relaunch; boot
 * adoption (packages/app main.tsx) then re-adopts whatever it finds on every
 * launch. Until this module existed there was no remover anywhere, so a
 * rotated/revoked agent credential was re-adopted forever. Kept as its own
 * module (not folded into the persistence grab-bag) because future explicit
 * flows — sign-out, unpair, agent deletion — need the same clear.
 */

import {
  CLOUD_PAIR_LOCAL_STORAGE_KEY,
  CLOUD_PAIR_SESSION_STORAGE_KEY,
} from "../components/auth/CloudPairRelay";
import { shellLocalStorage } from "../surface-realm-channel";

/**
 * Remove the durable pair token from BOTH storages the write channel targets.
 * Storage-scoped on purpose — the live bearer/boot-config are left alone so
 * in-flight requests are not broken; the auth wall renders next and the next
 * boot finds nothing to re-adopt. sessionStorage is addressed raw (mirroring
 * the write channel, which uses raw window storage; there is no
 * shellSessionStorage wrapper).
 */
export function clearCloudPairApiToken(): void {
  try {
    shellLocalStorage.removeItem(CLOUD_PAIR_LOCAL_STORAGE_KEY);
  } catch (_storageError) {
    // error-policy:J3 hardened settings can disable storage; nothing persisted
    // means nothing to re-adopt.
  }
  try {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(CLOUD_PAIR_SESSION_STORAGE_KEY);
    }
  } catch (_storageError) {
    // error-policy:J3 same as above for the session copy.
  }
}
