import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./prepare-worker-secrets.sh", import.meta.url),
);
const checkout = resolve(dirname(script), "../../..");
const source = readFileSync(script, "utf8");

// Execute the real deployment preflight. The two CLI shims cannot reach any
// service; the existing next validator is an explicit stop before mutations.
function preflight({
  environment = "production",
  provider = "",
  rate = "",
  key = "",
  names = [] as string[],
  stripe = {} as Record<string, string>,
  catalogStatus = 0,
}) {
  const root = mkdtempSync(join(tmpdir(), "cartesia-deploy-preflight-"));
  try {
    writeFileSync(
      join(root, "inventory.json"),
      JSON.stringify(names.map((name) => ({ name }))),
    );
    writeFileSync(
      join(root, "bunx"),
      `#!/bin/sh
[ "$1" = "wrangler@4.116.0" ] && [ "$2" = "secret" ] && [ "$3" = "list" ] || exit 91
cat "$FIXTURE_INVENTORY"
`,
    );
    writeFileSync(
      join(root, "bun"),
      `#!/bin/sh
case "$1" in
  ../scripts/validate-staging-session-cutover.ts) exit 77 ;;
esac
case "$2" in
  */preflight-subscription-catalog.ts)
    echo fixture_catalog_checked
    exit "$FIXTURE_CATALOG_STATUS"
    ;;
esac
exec "$FIXTURE_NODE" "$@"
`,
    );
    chmodSync(join(root, "bunx"), 0o700);
    chmodSync(join(root, "bun"), 0o700);
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${root}:${process.env.PATH}`,
        FIXTURE_NODE: process.execPath,
        FIXTURE_INVENTORY: join(root, "inventory.json"),
        CHECKOUT_DIR: checkout,
        WRANGLER_ARGS: "",
        DEPLOY_ENVIRONMENT: environment,
        VOICE_REALTIME_WS_ENABLED: "false",
        VOICE_REALTIME_ELIZA_AUTHORIZATION: "",
        STAGING_ELIZACLOUD_API_KEY: "",
        VOICE_BATCH_STT_PROVIDER: provider,
        CARTESIA_STT_USD_PER_CREDIT: rate,
        CARTESIA_API_KEY: key,
        FIXTURE_CATALOG_STATUS: String(catalogStatus),
        ...stripe,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const stripeCatalog = {
  STRIPE_SECRET_KEY: "sk_test_fixtureSecret",
  STRIPE_PLUS_PRODUCT_ID: "prod_fixturePlus",
  STRIPE_PLUS_MONTHLY_PRICE_ID: "price_fixturePlus",
  STRIPE_PRO_PRODUCT_ID: "prod_fixturePro",
  STRIPE_PRO_MONTHLY_PRICE_ID: "price_fixturePro",
};

test("staging preserves an entirely blank Stripe catalog and refuses each partial replacement", () => {
  const blank = preflight({ environment: "staging" });
  assert.equal(blank.status, 77, blank.stderr);
  assert.doesNotMatch(blank.stdout, /fixture_catalog_checked/);
  for (const [name, value] of Object.entries(stripeCatalog)) {
    const partial = preflight({
      environment: "staging",
      stripe: { [name]: value },
    });
    assert.equal(partial.status, 1);
    assert.match(
      partial.stdout + partial.stderr,
      /all four approved product\/price bindings/,
    );
    assert.doesNotMatch(partial.stdout + partial.stderr, new RegExp(value));
  }
});

test("a full test catalog is checked before preparation and provider failure stops it", () => {
  const checked = preflight({ environment: "staging", stripe: stripeCatalog });
  assert.equal(checked.status, 77, checked.stderr);
  assert.match(checked.stdout, /fixture_catalog_checked/);
  const unavailable = preflight({
    environment: "staging",
    stripe: stripeCatalog,
    catalogStatus: 78,
  });
  assert.equal(unavailable.status, 78);
});

test("staging rejects live keys and malformed independent Stripe inputs without logging their values", () => {
  for (const stripe of [
    { ...stripeCatalog, STRIPE_SECRET_KEY: "sk_live_privateFixture" },
    { STRIPE_PUBLISHABLE_KEY: "pk_live_privateFixture" },
    { STRIPE_WEBHOOK_SECRET: "malformed_privateFixture" },
  ]) {
    const rejected = preflight({ environment: "staging", stripe });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout + rejected.stderr, /Staging Stripe/);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /privateFixture/);
  }
});

test("production ignores staging Stripe input and never checks or rotates its catalog", () => {
  const result = preflight({
    environment: "production",
    names: ["CARTESIA_API_KEY", "CARTESIA_STT_USD_PER_CREDIT"],
    stripe: { ...stripeCatalog, STRIPE_SECRET_KEY: "sk_live_privateFixture" },
  });
  assert.equal(result.status, 77, result.stderr);
  assert.doesNotMatch(result.stdout, /fixture_catalog_checked/);
});

test("blank production sources accept existing key and billing rate without reading values", () => {
  const result = preflight({
    names: ["CARTESIA_API_KEY", "CARTESIA_STT_USD_PER_CREDIT"],
  });
  assert.equal(result.status, 77, result.stderr);
  assert.match(result.stdout, /values were not read/);
});

test("production with a blank provider source rejects a missing billing rate before mutation", () => {
  const result = preflight({ names: ["CARTESIA_API_KEY"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CARTESIA_STT_USD_PER_CREDIT/);
});

test("queued key and positive billing rate can initialize a Cartesia deployment", () => {
  const result = preflight({
    provider: "cartesia",
    key: "fixture-only",
    rate: "0.001",
  });
  assert.equal(result.status, 77, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-only|0\.001/);
});

test("invalid configured billing rates fail without printing their values", () => {
  for (const rate of ["0", "-1", "Infinity", "not-a-private-rate"]) {
    const result = preflight({ rate });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be positive and finite/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /not-a-private-rate|Infinity/,
    );
  }
});

test("staging only requires batch billing when Cartesia is explicitly selected", () => {
  assert.equal(preflight({ environment: "staging" }).status, 77);
  const selected = preflight({ environment: "staging", provider: "cartesia" });
  assert.equal(selected.status, 1);
  assert.match(selected.stderr, /CARTESIA_STT_USD_PER_CREDIT/);
});

test("billing rate is preserved rather than passed to the toggle deletion loop", () => {
  const toggleLoop = source.slice(
    source.indexOf("# Routing toggles:"),
    source.indexOf("# Preserve the production fail-closed boundary"),
  );
  assert.doesNotMatch(toggleLoop, /CARTESIA_STT_USD_PER_CREDIT/);
  const managedLoop = source.slice(
    source.lastIndexOf("for name in", source.indexOf("  OPENROUTER_API_KEY")),
    source.indexOf("# Routing toggles:"),
  );
  assert.match(managedLoop, /CARTESIA_STT_USD_PER_CREDIT/);
});

for (const [environment, configureStripe] of [
  ["production", true],
  ["staging", true],
  ["staging", false],
] as const)
  test(`full ${environment} preparation with ${configureStripe ? "configured" : "blank"} Stripe inputs preserves only the intended bindings`, {
    timeout: 60_000,
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "cartesia-full-prepare-"));
    const originalNames = [
      "CARTESIA_API_KEY",
      "CARTESIA_STT_USD_PER_CREDIT",
      "VOICE_REALTIME_CARTESIA_VOICE_ID",
      "VOICE_REALTIME_ELIZA_AUTHORIZATION",
      "VOICE_REALTIME_ELIZA_ENDPOINT",
      ...Object.keys(stripeCatalog),
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PUBLISHABLE_KEY",
    ];
    try {
      const inventory = join(root, "inventory.json");
      const deletions = join(root, "deletions.json");
      const queued = join(root, "queued.json");
      writeFileSync(
        inventory,
        JSON.stringify(originalNames.map((name) => ({ name }))),
      );
      writeFileSync(deletions, "[]");
      writeFileSync(
        join(root, "bunx"),
        `#!/bin/sh
[ "$1" = "wrangler@4.116.0" ] && [ "$2" = "secret" ] && [ "$3" = "list" ] || exit 91
cat "$FIXTURE_INVENTORY"
`,
      );
      writeFileSync(
        join(root, "node"),
        `#!/bin/sh
exec "$FIXTURE_NODE" "$FIXTURE_DRIVER" "$@"
`,
      );
      writeFileSync(
        join(root, "bun"),
        `#!/bin/sh
exec "$FIXTURE_NODE" "$FIXTURE_DRIVER" "$@"
`,
      );
      // Only external CLI boundaries are mocked. All shell queue/deletion logic
      // and the existing name verifier execute unchanged; no network is allowed.
      writeFileSync(
        join(root, "driver.cjs"),
        `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const name = path.basename(args[0] || "");
if (args.some(arg => arg.endsWith("/preflight-subscription-catalog.ts"))) {
  process.stdout.write("fixture_catalog_checked");
} else if (name === "ensure-worker-secret-absent.ts") {
  const target = args[2];
  const deletes = JSON.parse(fs.readFileSync(process.env.FIXTURE_DELETIONS, "utf8"));
  deletes.push(target);
  fs.writeFileSync(process.env.FIXTURE_DELETIONS, JSON.stringify(deletes));
  const inventory = JSON.parse(fs.readFileSync(process.env.FIXTURE_INVENTORY, "utf8"));
  fs.writeFileSync(process.env.FIXTURE_INVENTORY, JSON.stringify(inventory.filter(entry => entry.name !== target)));
  process.stdout.write("absent");
} else if (name === "worker-secrets-file.ts") {
  if (args[1] !== "create") process.exit(92);
  fs.writeFileSync(process.env.FIXTURE_QUEUED, JSON.stringify(args.slice(3)));
  process.stdout.write(path.join(process.env.RUNNER_TEMP, "fixture-secrets.json"));
} else if (["validate-staging-session-cutover.ts", "verify-network-site-auth-binding.ts", "verify-steward-upstream-binding.ts"].includes(name)) {
  // Unrelated policy gates are outside this isolated regression.
} else if (name === "verify-worker-secret-binding-names.ts" || args[0] === "-e" || args[0] === "--input-type=module") {
  const child = spawnSync(process.env.FIXTURE_NODE, args, { stdio: "inherit", env: process.env });
  process.exit(child.status ?? 93);
} else {
  process.stderr.write("Unexpected command boundary: " + name);
  process.exit(94);
}
`,
      );
      chmodSync(join(root, "bunx"), 0o700);
      chmodSync(join(root, "node"), 0o700);
      chmodSync(join(root, "bun"), 0o700);
      const env: Record<string, string> = {};
      // Empty optional settings simulate a protected environment which cannot
      // recover the existing secrets; never inherit actual host credentials.
      for (const match of source.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g))
        env[match[1]] = "";
      Object.assign(env, {
        PATH: `${root}:${process.env.PATH}`,
        FIXTURE_NODE: process.execPath,
        FIXTURE_DRIVER: join(root, "driver.cjs"),
        FIXTURE_INVENTORY: inventory,
        FIXTURE_DELETIONS: deletions,
        FIXTURE_QUEUED: queued,
        CHECKOUT_DIR: checkout,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: join(root, "github-output"),
        DEPLOY_ENVIRONMENT: environment,
        VOICE_REALTIME_WS_ENABLED:
          environment === "production" ? "true" : "false",
        OPENROUTER_API_KEY: "fixture-model",
        ELIZA_APP_TELEGRAM_BOT_TOKEN: "fixture-telegram",
        ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "fixture-webhook",
        ELIZA_APP_BLOOIO_API_KEY: "fixture-blooio",
        ELIZA_APP_BLOOIO_PHONE_NUMBER: "fixture-number",
        ELIZA_APP_BLOOIO_WEBHOOK_SECRET: "fixture-blooio-webhook",
        ...(configureStripe
          ? {
              ...stripeCatalog,
              STRIPE_WEBHOOK_SECRET: "whsec_fixtureWebhook",
              STRIPE_PUBLISHABLE_KEY: "pk_test_fixturePublic",
            }
          : {}),
      });
      const result = spawnSync("bash", [script], { encoding: "utf8", env });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const deletedNames = JSON.parse(readFileSync(deletions, "utf8"));
      const remainingNames = JSON.parse(readFileSync(inventory, "utf8")).map(
        (entry: { name: string }) => entry.name,
      );
      const queuedNames = JSON.parse(readFileSync(queued, "utf8"));
      for (const name of ["CARTESIA_API_KEY", "CARTESIA_STT_USD_PER_CREDIT"]) {
        assert.ok(!deletedNames.includes(name), `${name} was deleted`);
        assert.ok(remainingNames.includes(name), `${name} disappeared`);
        assert.ok(
          !queuedNames.includes(name),
          `${name} was replaced despite its blank source`,
        );
      }
      for (const name of [
        ...Object.keys(stripeCatalog),
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PUBLISHABLE_KEY",
      ]) {
        assert.equal(
          queuedNames.includes(name),
          environment === "staging" && configureStripe,
          name,
        );
        assert.ok(!deletedNames.includes(name), `${name} was deleted`);
        assert.ok(remainingNames.includes(name), `${name} disappeared`);
      }
      assert.match(
        readFileSync(join(root, "github-output"), "utf8"),
        /secrets_file=/,
      );
      const output = readFileSync(join(root, "github-output"), "utf8");
      assert.match(output, /^stripe_binding_names=/m);
      if (environment !== "staging" || !configureStripe)
        assert.match(output, /^stripe_binding_names=$/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("caller passes the billing secret through the reusable workflow into preparation", () => {
  const caller = readFileSync(
    join(checkout, ".github/workflows/cloud-cf-deploy.yml"),
    "utf8",
  );
  const callee = readFileSync(
    join(checkout, ".github/workflows/cloud-cf-release.yml"),
    "utf8",
  );
  assert.match(
    caller,
    /CARTESIA_STT_USD_PER_CREDIT: \$\{\{ secrets\.CARTESIA_STT_USD_PER_CREDIT \}\}/,
  );
  assert.match(callee, /CARTESIA_STT_USD_PER_CREDIT:\n {8}required: false/);
  assert.match(
    callee,
    /CARTESIA_STT_USD_PER_CREDIT: \$\{\{ vars\.CARTESIA_STT_USD_PER_CREDIT \|\| secrets\.CARTESIA_STT_USD_PER_CREDIT \}\}/,
  );
});

function subscriptionCatalogFixture(suffix: string) {
  const env = {
    ENVIRONMENT: "staging",
    STRIPE_SECRET_KEY: `sk_test_catalog${suffix}`,
    STRIPE_PLUS_PRODUCT_ID: `prod_plus${suffix}`,
    STRIPE_PLUS_MONTHLY_PRICE_ID: `price_plus${suffix}`,
    STRIPE_PRO_PRODUCT_ID: `prod_pro${suffix}`,
    STRIPE_PRO_MONTHLY_PRICE_ID: `price_pro${suffix}`,
    STRIPE_SUBSCRIPTION_PREFLIGHT_WRONG_PRICE_ID: `price_wrong${suffix}`,
  };
  const reads: string[] = [];
  const provider = {
    async retrievePrice(priceId: string) {
      reads.push(priceId);
      const plus = priceId === env.STRIPE_PLUS_MONTHLY_PRICE_ID;
      const pro = priceId === env.STRIPE_PRO_MONTHLY_PRICE_ID;
      return {
        active: true,
        currency: "usd",
        currencyOptions: [],
        unitAmount: plus ? 3000 : pro ? 10000 : 1,
        type: "recurring",
        billingScheme: "per_unit",
        transformQuantity: null,
        recurring: {
          interval: "month",
          intervalCount: 1,
          trialPeriodDays: null,
          usageType: "licensed",
        },
        productId: plus
          ? env.STRIPE_PLUS_PRODUCT_ID
          : env.STRIPE_PRO_PRODUCT_ID,
        livemode: false,
      };
    },
    async retrieveProduct(productId: string) {
      reads.push(productId);
      return { active: true, deleted: false, livemode: false };
    },
  };
  return { env, reads, provider };
}

test("release catalog preflight verifies both exact plans without claiming the optional negative fixture", async () => {
  const { runSubscriptionCatalogPreflight } = await import(
    "./admin/preflight-subscription-catalog"
  );
  const fixture = subscriptionCatalogFixture("release");
  const { STRIPE_SUBSCRIPTION_PREFLIGHT_WRONG_PRICE_ID: _wrong, ...env } =
    fixture.env;
  const result = await runSubscriptionCatalogPreflight({
    env,
    provider: fixture.provider,
    catalogOnly: true,
  });
  assert.deepEqual(result.approvedPlanKeys, ["plus_monthly", "pro_monthly"]);
  assert.equal(result.approvedProviderObjects, 4);
  assert.equal(result.wrongFixtureRejected, false);
  assert.equal(fixture.reads.length, 4);
});

test("operator catalog preflight still rejects a known wrong price and release mode rejects provider drift", async () => {
  const { runSubscriptionCatalogPreflight } = await import(
    "./admin/preflight-subscription-catalog"
  );
  const fixture = subscriptionCatalogFixture("operator");
  const result = await runSubscriptionCatalogPreflight(fixture);
  assert.equal(result.wrongFixtureRejected, true);
  assert.ok(
    fixture.reads.includes(
      fixture.env.STRIPE_SUBSCRIPTION_PREFLIGHT_WRONG_PRICE_ID,
    ),
  );
  const bad = subscriptionCatalogFixture("drift");
  await assert.rejects(
    runSubscriptionCatalogPreflight({
      env: bad.env,
      catalogOnly: true,
      provider: {
        ...bad.provider,
        retrievePrice: async (id) => ({
          ...(await bad.provider.retrievePrice(id)),
          unitAmount: 1,
        }),
      },
    }),
    { code: "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT" },
  );
});
