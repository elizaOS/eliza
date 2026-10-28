/**
 * Mints Cloud subscription grant codes (for example Alpha Phone six-month
 * Plus codes). Only an HMAC of each code is stored; the plaintext codes are
 * printed once to stdout and cannot be recovered later.
 *
 * Requires DATABASE_URL and ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER (the same
 * pepper as the target Worker environment).
 *
 * Usage:
 *   bun --conditions=eliza-source packages/cloud/scripts/admin/mint-subscription-grant-codes.ts \
 *     --count 100 [--max-redemptions 1] [--duration-days 183 | --duration-months 6 | --lifetime] \
 *     [--plan plus_monthly] [--family alpha_phone] [--requires-no-paid-plan] \
 *     [--expires-at 2027-12-31T00:00:00Z] [--label "Alpha Phone batch 1"]
 *
 * `--duration-months` grants UTC calendar months from redemption (a month end
 * clamps, so Aug 31 + 6 is the end of February). `--requires-no-paid-plan`
 * refuses redemption while the organization has an open paid subscription.
 */

import { parseArgs } from "node:util";
import { loadEnvFiles } from "./local-dev-helpers";

/** Crockford base32 without I, L, O, U: unambiguous when read from a card or a screen. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 4;
const GROUP_LENGTH = 4;

/** 80 random bits as `XXXX-XXXX-XXXX-XXXX`. */
export function generateSubscriptionGrantCode(
  random: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  const characters: string[] = [];
  const bytes = random(new Uint8Array(GROUPS * GROUP_LENGTH));
  for (const byte of bytes)
    characters.push(ALPHABET.charAt(byte % ALPHABET.length));
  const groups: string[] = [];
  for (let index = 0; index < GROUPS; index += 1)
    groups.push(
      characters
        .slice(index * GROUP_LENGTH, (index + 1) * GROUP_LENGTH)
        .join(""),
    );
  return groups.join("-");
}

export interface MintOptions {
  count: number;
  maxRedemptions: number;
  durationDays: number | null;
  durationMonths: number | null;
  requiresNoPaidPlan: boolean;
  planKey: "plus_monthly" | "pro_monthly";
  family: string;
  expiresAt: Date | null;
  label: string | null;
}

export function parseMintOptions(argv: string[]): MintOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      count: { type: "string" },
      "max-redemptions": { type: "string", default: "1" },
      "duration-days": { type: "string" },
      "duration-months": { type: "string" },
      "requires-no-paid-plan": { type: "boolean", default: false },
      lifetime: { type: "boolean", default: false },
      plan: { type: "string", default: "plus_monthly" },
      family: { type: "string", default: "alpha_phone" },
      "expires-at": { type: "string" },
      label: { type: "string" },
    },
    strict: true,
  });
  const integer = (
    value: string | undefined,
    name: string,
    min: number,
    max: number,
  ) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
      throw new Error(`--${name} must be an integer from ${min} to ${max}`);
    return parsed;
  };
  if (values.plan !== "plus_monthly" && values.plan !== "pro_monthly")
    throw new Error("--plan must be plus_monthly or pro_monthly");
  if (
    [
      values.lifetime,
      values["duration-days"] !== undefined,
      values["duration-months"] !== undefined,
    ].filter(Boolean).length > 1
  )
    throw new Error(
      "--lifetime, --duration-days and --duration-months are mutually exclusive",
    );
  const durationMonths =
    values["duration-months"] === undefined
      ? null
      : integer(values["duration-months"], "duration-months", 1, 24);
  if (!/^[a-z0-9_]{1,64}$/.test(values.family ?? ""))
    throw new Error("--family must match ^[a-z0-9_]{1,64}$");
  const expiresAt = values["expires-at"]
    ? new Date(values["expires-at"])
    : null;
  if (expiresAt && !Number.isFinite(expiresAt.getTime()))
    throw new Error("--expires-at must be an ISO timestamp");
  if (values.label && values.label.length > 200)
    throw new Error("--label is at most 200 characters");
  return {
    count: integer(values.count, "count", 1, 10_000),
    maxRedemptions: integer(
      values["max-redemptions"],
      "max-redemptions",
      1,
      1_000_000,
    ),
    durationDays:
      values.lifetime || durationMonths !== null
        ? null
        : integer(values["duration-days"] ?? "183", "duration-days", 1, 731),
    durationMonths,
    requiresNoPaidPlan: values["requires-no-paid-plan"] === true,
    planKey: values.plan,
    family: values.family ?? "alpha_phone",
    expiresAt,
    label: values.label ?? null,
  };
}

async function main(): Promise<void> {
  loadEnvFiles();
  const options = parseMintOptions(process.argv.slice(2));
  const productionTest = process.env.ELIZA_PRODUCTION_TEST_GRANT === "1";
  if (
    productionTest &&
    (options.count !== 1 ||
      options.maxRedemptions !== 1 ||
      options.planKey !== "plus_monthly" ||
      !options.requiresNoPaidPlan ||
      options.durationMonths !== null ||
      options.durationDays === null ||
      options.durationDays > 31 ||
      options.family !== "production_qa")
  )
    throw new Error("production_grant_bounds_required");
  const pepper = process.env.ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER;
  if (!pepper || pepper.length < 32)
    throw new Error(
      "ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER must be set (at least 32 characters)",
    );
  const [{ dbWrite }, { subscriptionGrantCodes }, grants] = await Promise.all([
    import("@elizaos/cloud-shared/db/client"),
    import("@elizaos/cloud-shared/db/schemas/subscription-grants"),
    import("@elizaos/cloud-shared/db/repositories/subscription-grants"),
  ]);
  const codes = new Set<string>();
  while (codes.size < options.count) codes.add(generateSubscriptionGrantCode());
  const rows = await Promise.all(
    [...codes].map(async (code) => {
      const normalized = grants.normalizeSubscriptionGrantCode(code);
      if (!normalized) throw new Error("Generated code failed normalization");
      return {
        code_hash: await grants.hashSubscriptionGrantCode(normalized, pepper),
        family: options.family,
        plan_key: options.planKey,
        duration_days: options.durationDays,
        duration_months: options.durationMonths,
        requires_no_paid_plan: options.requiresNoPaidPlan,
        max_redemptions: options.maxRedemptions,
        expires_at: options.expiresAt,
        label: options.label,
      };
    }),
  );
  // One transaction: either every printed code exists, or none does.
  await dbWrite.transaction(async (tx) => {
    if (productionTest) {
      const [{ admitProductionTestGrant }, { sql }] = await Promise.all([
        import("./production-test-grant-admission"),
        import("drizzle-orm"),
      ]);
      await admitProductionTestGrant({
        query: async (text) => {
          const result = await tx.execute(sql.raw(text));
          return { rows: result.rows };
        },
      });
    }
    await tx.insert(subscriptionGrantCodes).values(rows);
  });
  console.error(
    `Minted ${codes.size} ${options.planKey} code(s), family ${options.family}, ${options.durationMonths !== null ? `${options.durationMonths} calendar months` : options.durationDays === null ? "lifetime" : `${options.durationDays} days`}${options.requiresNoPaidPlan ? ", refused for paying accounts" : ""}, ` +
      `${options.maxRedemptions} redemption(s) each. Store them now; they are not recoverable.`,
  );
  for (const code of codes) console.log(code);
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      if (process.env.ELIZA_PRODUCTION_TEST_GRANT === "1") {
        const message = error instanceof Error ? error.message : "";
        console.error(
          /^production_grant_[a-z0-9_]+$/.test(message)
            ? message
            : "production_grant_mint_failed",
        );
      } else console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
