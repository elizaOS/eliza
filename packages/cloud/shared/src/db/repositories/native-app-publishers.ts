import { ElizaError } from "@elizaos/core";
import { eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { nativeAppPublishers } from "../schemas/native-app-publishers";
import { organizations } from "../schemas/organizations";

export async function isNativeAppPublisher(
  organizationId: string,
  database: DbTransaction | typeof dbWrite = dbWrite,
): Promise<boolean> {
  const [publisher] = await database
    .select({ organizationId: nativeAppPublishers.organization_id })
    .from(nativeAppPublishers)
    .where(eq(nativeAppPublishers.organization_id, organizationId))
    .limit(1);
  return publisher !== undefined;
}

export async function assertNotNativeAppPublisher(
  organizationId: string,
  database: DbTransaction | typeof dbWrite = dbWrite,
): Promise<void> {
  if (await isNativeAppPublisher(organizationId, database)) {
    throw new ElizaError("Native app publisher organizations require explicit retirement", {
      code: "NATIVE_APP_PUBLISHER_RETIREMENT_REQUIRED",
      severity: "ephemeral",
    });
  }
}

/** Serialize retirement/deactivation against a concurrent publisher registration. */
export async function lockNonPublisherOrganization(
  organizationId: string,
  transaction: DbTransaction,
): Promise<void> {
  await transaction
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
  await assertNotNativeAppPublisher(organizationId, transaction);
}
