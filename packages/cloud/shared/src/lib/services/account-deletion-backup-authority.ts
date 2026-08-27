/**
 * Composes account-deletion backup absence authority from the exact immutable
 * R2 and Hetzner registry. It enumerates the canonical organization prefix on
 * every configured provider, including objects whose catalogue row was lost,
 * and never treats a missing provider or invalid page as absence.
 */

import { ElizaError } from "@elizaos/core/edge";
import type {
  AgentBackupObjectStore,
  AgentBackupObjectStoreRegistry,
} from "../storage/agent-backup-object-store";
import type { AccountDeletionBackupAuthority } from "./account-deletion-provider-adapters";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LIST_PAGES = 100_000;

function authorityError(code: string, message: string, cause?: unknown): never {
  throw new ElizaError(message, {
    code,
    cause,
    severity: "fatal",
  });
}

function organizationPrefix(organizationId: string): string {
  if (!UUID_PATTERN.test(organizationId)) {
    authorityError(
      "ACCOUNT_DELETION_BACKUP_ORGANIZATION_INVALID",
      "Backup deletion requires a canonical organization identity",
    );
  }
  return `agent-sandbox-backups/v2/${organizationId}/`;
}

function configuredStores(
  registry: AgentBackupObjectStoreRegistry,
): readonly AgentBackupObjectStore[] {
  const stores = registry.configuredStores();
  const providers = new Set(stores.map((store) => store.authority.provider));
  if (
    stores.length !== 2 ||
    !providers.has("cloudflare-r2") ||
    !providers.has("hetzner-object-storage")
  ) {
    authorityError(
      "ACCOUNT_DELETION_BACKUP_AUTHORITY_INCOMPLETE",
      "Backup deletion requires exact primary and secondary storage authorities",
    );
  }
  return stores;
}

async function listOrganizationKeys(
  store: AgentBackupObjectStore,
  prefix: string,
): Promise<readonly string[]> {
  const keys: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    let page: Awaited<ReturnType<AgentBackupObjectStore["listKeys"]>>;
    try {
      page = await store.listKeys({ prefix, cursor });
    } catch (cause) {
      // error-policy:J2 provider inspection failures retain their cause behind
      // one account-deletion authority error for saga retry classification.
      authorityError(
        "ACCOUNT_DELETION_BACKUP_INSPECTION_UNAVAILABLE",
        "Backup deletion could not inspect an exact provider prefix",
        cause,
      );
    }
    keys.push(...page.keys);
    if (!page.truncated) return Object.freeze(keys);
    if (!page.cursor || seenCursors.has(page.cursor)) {
      authorityError(
        "ACCOUNT_DELETION_BACKUP_CURSOR_INVALID",
        "Backup deletion provider listing did not advance",
      );
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  authorityError(
    "ACCOUNT_DELETION_BACKUP_INVENTORY_TOO_LARGE",
    "Backup deletion provider inventory exceeds the bounded page limit",
  );
}

function requireIdempotencyKey(value: string): void {
  if (
    !value ||
    value !== value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    authorityError(
      "ACCOUNT_DELETION_BACKUP_IDEMPOTENCY_INVALID",
      "Backup deletion requires a canonical idempotency key",
    );
  }
}

/** Build remote backup purge/inspection from one pinned two-provider registry. */
export function createAccountDeletionBackupAuthority(
  registry: AgentBackupObjectStoreRegistry,
): AccountDeletionBackupAuthority {
  const stores = configuredStores(registry);
  return Object.freeze({
    async inspectOrganizationBackups({ organizationId }: { organizationId: string }) {
      const prefix = organizationPrefix(organizationId);
      for (const store of stores) {
        if ((await listOrganizationKeys(store, prefix)).length > 0) return "present";
      }
      return "absent";
    },

    async purgeOrganizationBackups({
      organizationId,
      idempotencyKey,
    }: {
      organizationId: string;
      idempotencyKey: string;
    }) {
      requireIdempotencyKey(idempotencyKey);
      const prefix = organizationPrefix(organizationId);
      for (const store of stores) {
        for (const key of await listOrganizationKeys(store, prefix)) {
          const observed = await store.head(key);
          if (observed.status === "present") {
            await store.delete({ key, locator: observed.locator });
          }
        }
      }
    },
  });
}
