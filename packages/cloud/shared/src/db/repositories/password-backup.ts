import { Buffer } from "node:buffer";
import { sql } from "drizzle-orm";
import { dbWrite } from "../client";

export const MAX_PASSWORD_BACKUP_BYTES = 2 * 1024 * 1024;

export type PasswordBackupScope = {
  appId: string;
  organizationId: string;
  userId: string;
};

type BackupRow = { revision: number; snapshot: Buffer | null };
type BackupChange =
  | { kind: "save"; expectedRevision: number | null; snapshot: Uint8Array }
  | { kind: "delete"; expectedRevision: number };

export async function assertPasswordBackupStorageReady() {
  await dbWrite.execute(sql`SELECT revision FROM password_backups LIMIT 0`);
}

export async function readPasswordBackup(scope: PasswordBackupScope) {
  const { appId, organizationId, userId } = scope;
  const result = await dbWrite.execute<BackupRow>(sql`
    SELECT revision, snapshot FROM password_backups
    WHERE app_id = ${appId} AND organization_id = ${organizationId} AND user_id = ${userId}
  `);
  return result.rows[0] ?? null;
}

export async function readPasswordBackupState(scope: PasswordBackupScope) {
  const { appId, organizationId, userId } = scope;
  const result = await dbWrite.execute<{ revision: number; present: boolean }>(sql`
    SELECT revision, snapshot IS NOT NULL AS present FROM password_backups
    WHERE app_id = ${appId} AND organization_id = ${organizationId} AND user_id = ${userId}
  `);
  return result.rows[0] ?? null;
}

export async function changePasswordBackup(scope: PasswordBackupScope, change: BackupChange) {
  const { appId, organizationId, userId } = scope;
  if (
    change.kind === "save" &&
    (change.snapshot.byteLength === 0 || change.snapshot.byteLength > MAX_PASSWORD_BACKUP_BYTES)
  ) {
    return { kind: "invalid_size" } as const;
  }
  const snapshot = change.kind === "save" ? Buffer.from(change.snapshot) : null;
  const result =
    change.expectedRevision === null
      ? await dbWrite.execute<Pick<BackupRow, "revision">>(sql`
        INSERT INTO password_backups (app_id, organization_id, user_id, revision, snapshot)
        VALUES (${appId}, ${organizationId}, ${userId}, 1, ${snapshot})
        ON CONFLICT (app_id, organization_id, user_id) DO NOTHING
        RETURNING revision
      `)
      : await dbWrite.execute<Pick<BackupRow, "revision">>(sql`
        UPDATE password_backups SET revision = revision + 1, snapshot = ${snapshot}
        WHERE app_id = ${appId} AND organization_id = ${organizationId} AND user_id = ${userId}
          AND revision = ${change.expectedRevision}
          AND revision < 2147483647
          AND (${change.kind === "save"} OR snapshot IS NOT NULL)
        RETURNING revision
      `);
  const written = result.rows[0];
  return written
    ? ({ kind: "changed", revision: written.revision } as const)
    : ({ kind: "conflict" } as const);
}
