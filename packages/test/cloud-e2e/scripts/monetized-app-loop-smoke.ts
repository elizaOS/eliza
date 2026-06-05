/**
 * Monetized-app loop smoke test (run against a live cloud:mock stack).
 *
 * Proves the autonomous monetized-app loop end to end on the local mock:
 *   seed org (1000 credits) → apps.create → apps.monetization.update →
 *   domains.check → domains.buy (Cloudflare stub, real credit debit) →
 *   record inference-markup earnings → survival-economics decision
 *   (computeContainerBillingPlan: earnings pay the daily container bill, so an
 *   earning agent stays alive; a broke agent hits the shutdown path).
 *
 * Run with bun (so `@elizaos/cloud-shared` TS + the seed fixture resolve). The
 * stack must be booted in e2e mode so the worker uses the in-memory KMS and the
 * Cloudflare registrar stub:
 *
 *   # terminal 1 — boot the API-only mock stack in e2e mode
 *   CLOUD_E2E=1 NODE_ENV=test bun run cloud:mock --no-frontend --reset
 *   # note the "Ready on http://127.0.0.1:<apiPort>" and "[pglite] DATABASE_URL=..."
 *
 *   # terminal 2 — run the smoke
 *   API_BASE=http://127.0.0.1:<apiPort> \
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:<pglitePort>/postgres \
 *   NODE_ENV=test ELIZA_KMS_BACKEND=memory \
 *   bun run packages/test/cloud-e2e/scripts/monetized-app-loop-smoke.ts
 *
 * Exits non-zero if any assertion fails.
 */
import { computeContainerBillingPlan } from "@elizaos/cloud-shared/lib/services/container-billing-policy";
import { redeemableEarningsService } from "@elizaos/cloud-shared/lib/services/redeemable-earnings";
import { seedTestUser } from "../src/fixtures/seed";

const API = process.env.API_BASE ?? "http://127.0.0.1:8787";
const DAILY_CONTAINER_COST_USD = 0.67;

const failures: string[] = [];
function check(label: string, cond: boolean): void {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}`);
  if (!cond) failures.push(label);
}

function log(step: string, data: unknown): void {
  console.log(`\n=== ${step} ===`);
  console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

async function call(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-API-Key": apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 400);
  }
  return { status: res.status, json };
}

async function main(): Promise<void> {
  const health = await fetch(`${API}/api/health`).then((r) => r.status);
  log("health", { status: health });

  // Seed an org (1000 credits) + API key directly in the DB.
  const seeded = await seedTestUser({
    slug: `loop-${Date.now().toString(36)}`,
  });
  log("seedTestUser", {
    organizationId: seeded.organizationId,
    apiKeyPrefix: `${seeded.apiKey.slice(0, 12)}…`,
  });
  const key = seeded.apiKey;

  log("credits.balance", await call("GET", "/api/v1/credits/balance", key));

  // 1. Create the app.
  const created = await call("POST", "/api/v1/apps", key, {
    name: `Loop App ${Date.now().toString(36)}`,
    app_url: "https://placeholder.invalid",
    skipGitHubRepo: true,
  });
  log("apps.create", created);
  const appId = created.json?.app?.id ?? created.json?.id;
  if (!appId) {
    log("ABORT", "no appId from apps.create");
    process.exitCode = 1;
    return;
  }

  // 2. Enable monetization (inference markup + purchase share).
  log(
    "apps.monetization.update",
    await call("PUT", `/api/v1/apps/${appId}/monetization`, key, {
      monetizationEnabled: true,
      inferenceMarkupPercentage: 100,
      purchaseSharePercentage: 10,
    }),
  );

  // 3. Buy a custom domain (Cloudflare stub) — debits real credits.
  const domain = `loop-${Date.now().toString(36)}.com`;
  log(
    "domains.check",
    await call("POST", `/api/v1/apps/${appId}/domains/check`, key, { domain }),
  );
  const buy = await call("POST", `/api/v1/apps/${appId}/domains/buy`, key, {
    domain,
  });
  log("domains.buy", buy);

  const afterBuy = await call("GET", "/api/v1/credits/balance", key);
  log("credits.balance (after buy)", afterBuy);
  const balAfterBuy = Number(afterBuy.json?.balance);

  // 4. Record inference-markup earnings for the app owner.
  const earn = await redeemableEarningsService.addEarnings({
    userId: seeded.userId,
    amount: 5,
    source: "app_owner_revenue_share",
    sourceId: appId,
    description: "simulated inference markup",
  });
  log("addEarnings", earn);
  const bal = await redeemableEarningsService.getBalance(seeded.userId);
  log("earnings.getBalance", bal);

  // 5. Survival economics: the exact pure policy the container-billing cron
  //    uses. With earnings and ZERO org credits the bill is paid from earnings
  //    (agent stays alive); with neither it returns "insufficient" (shutdown).
  const survives = computeContainerBillingPlan({
    dailyCost: DAILY_CONTAINER_COST_USD,
    currentBalance: 0,
    ownerEarningsAvailable: bal?.availableBalance ?? 0,
    payAsYouGoFromEarnings: true,
  });
  log("billing plan (earnings, 0 credits)", survives);
  const broke = computeContainerBillingPlan({
    dailyCost: DAILY_CONTAINER_COST_USD,
    currentBalance: 0,
    ownerEarningsAvailable: 0,
    payAsYouGoFromEarnings: true,
  });
  log("billing plan (no earnings, no credits)", broke);

  const convert = await redeemableEarningsService.convertToCredits({
    userId: seeded.userId,
    amount: DAILY_CONTAINER_COST_USD,
    organizationId: seeded.organizationId,
    description: "survival: fund container hosting from earnings",
  });
  log("convertToCredits (daily cost)", convert);

  console.log("\n=== ASSERTIONS ===");
  check("app created", Boolean(appId));
  check(
    "domain registered + attached",
    buy.json?.success === true && buy.json?.verified === true,
  );
  check(
    "domain debited (~$14.95 off 1000)",
    Math.abs(balAfterBuy - 985.05) < 0.01,
  );
  check("earnings recorded ($5 available)", (bal?.availableBalance ?? 0) === 5);
  check(
    "earning agent survives: daily bill paid from earnings",
    survives.action === "billed" &&
      survives.fromEarnings >= DAILY_CONTAINER_COST_USD - 1e-9,
  );
  check(
    "broke agent flagged insufficient (shutdown path)",
    broke.action === "insufficient",
  );
  check("earnings drawn down for hosting", convert.success === true);

  console.log(
    `\n=== ${failures.length === 0 ? "ALL PASS" : `FAILED (${failures.length})`} ===`,
  );
  log("DONE", {
    appId,
    domain,
    organizationId: seeded.organizationId,
    balAfterBuy,
  });
  if (failures.length > 0) process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error("monetized-app-loop-smoke error:", err);
    process.exit(1);
  },
);
