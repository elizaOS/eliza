/**
 * Revokes redeemed Cloud subscription grants (for example a leaked or resold
 * batch of Alpha Phone codes). Each grant is revoked in its own transaction:
 * the grant is marked revoked, its open allowance buckets are retired, an
 * organization projection that names it moves to the next active grant or back
 * to free, and the organization policy generation advances. Admission stops
 * serving the grant at once. Revoking an already revoked grant is a no-op.
 *
 * Select grants by id, or by plaintext code (needs the environment's pepper).
 * `--code` also disables the code, so it cannot be redeemed again.
 *
 * Requires DATABASE_URL (and ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER for --code).
 *
 * Usage:
 *   bun --conditions=eliza-source packages/cloud/scripts/admin/revoke-subscription-grants.ts \
 *     --reason "leaked batch 3" (--grant-id <uuid> ... | --code XXXX-XXXX-XXXX-XXXX ...)
 */

import { parseArgs } from "node:util";
import { loadEnvFiles } from "./local-dev-helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RevokeOptions {
  reason: string;
  grantIds: string[];
  codes: string[];
}

export function parseRevokeOptions(argv: string[]): RevokeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      reason: { type: "string" },
      "grant-id": { type: "string", multiple: true, default: [] },
      code: { type: "string", multiple: true, default: [] },
    },
    strict: true,
  });
  const reason = values.reason?.trim() ?? "";
  if (reason.length < 1 || reason.length > 500)
    throw new Error("--reason is required (1 to 500 characters)");
  const grantIds = values["grant-id"] ?? [];
  const codes = values.code ?? [];
  if (grantIds.length + codes.length === 0)
    throw new Error("Pass at least one --grant-id or --code");
  for (const id of grantIds)
    if (!UUID.test(id)) throw new Error(`--grant-id ${id} is not a UUID`);
  return { reason, grantIds, codes };
}

async function main(): Promise<void> {
  loadEnvFiles();
  const options = parseRevokeOptions(process.argv.slice(2));
  const [{ dbWrite }, schema, grants, { eq, inArray, isNull, and }] =
    await Promise.all([
      import("@elizaos/cloud-shared/db/client"),
      import("@elizaos/cloud-shared/db/schemas/subscription-grants"),
      import("@elizaos/cloud-shared/db/repositories/subscription-grants"),
      import("drizzle-orm"),
    ]);
  const grantIds = new Set(options.grantIds);
  if (options.codes.length > 0) {
    const pepper = process.env.ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER;
    if (!pepper)
      throw new Error(
        "ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER must be set to select by --code",
      );
    const hashes: string[] = [];
    for (const code of options.codes) {
      const normalized = grants.normalizeSubscriptionGrantCode(code);
      if (!normalized) throw new Error(`${code} is not a subscription code`);
      hashes.push(await grants.hashSubscriptionGrantCode(normalized, pepper));
    }
    const codes = await dbWrite
      .update(schema.subscriptionGrantCodes)
      .set({ disabled_at: new Date() })
      .where(
        and(
          inArray(schema.subscriptionGrantCodes.code_hash, hashes),
          isNull(schema.subscriptionGrantCodes.disabled_at),
        ),
      )
      .returning({ id: schema.subscriptionGrantCodes.id });
    const known = await dbWrite
      .select({ id: schema.subscriptionGrantCodes.id })
      .from(schema.subscriptionGrantCodes)
      .where(inArray(schema.subscriptionGrantCodes.code_hash, hashes));
    console.error(
      `Matched ${known.length} of ${hashes.length} code(s); disabled ${codes.length}.`,
    );
    for (const { id } of known) {
      const rows = await dbWrite
        .select({ id: schema.subscriptionGrants.id })
        .from(schema.subscriptionGrants)
        .where(eq(schema.subscriptionGrants.code_id, id));
      for (const row of rows) grantIds.add(row.id);
    }
  }
  let revoked = 0;
  for (const grantId of grantIds) {
    const result = await grants.subscriptionGrantsRepository.revoke({
      grantId,
      reason: options.reason,
    });
    if (result.revoked) revoked += 1;
    console.log(
      `${grantId} organization=${result.grant.organization_id} ${
        result.revoked
          ? `revoked, ${result.retiredPeriods} allowance bucket(s) retired`
          : "already revoked"
      }`,
    );
  }
  console.error(`Revoked ${revoked} of ${grantIds.size} grant(s).`);
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
