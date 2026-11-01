import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./prepare-worker-secrets.sh", import.meta.url));
const checkout = resolve(dirname(script), "../../..");
const source = readFileSync(script, "utf8");

// Execute the real deployment preflight. The two CLI shims cannot reach any
// service; the existing next validator is an explicit stop before mutations.
function preflight({ environment = "production", provider = "", rate = "", key = "", names = [] as string[] }) {
  const root = mkdtempSync(join(tmpdir(), "cartesia-deploy-preflight-"));
  try {
    writeFileSync(join(root, "inventory.json"), JSON.stringify(names.map((name) => ({ name }))));
    writeFileSync(join(root, "bunx"), `#!/bin/sh
[ "$1" = "wrangler@4.116.0" ] && [ "$2" = "secret" ] && [ "$3" = "list" ] || exit 91
cat "$FIXTURE_INVENTORY"
`);
    writeFileSync(join(root, "node"), `#!/bin/sh
case "$1" in
  ../scripts/validate-staging-session-cutover.ts) exit 77 ;;
esac
exec "$FIXTURE_NODE" "$@"
`);
    chmodSync(join(root, "bunx"), 0o700);
    chmodSync(join(root, "node"), 0o700);
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
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("blank production sources accept existing key and billing rate without reading values", () => {
  const result = preflight({ names: ["CARTESIA_API_KEY", "CARTESIA_STT_USD_PER_CREDIT"] });
  assert.equal(result.status, 77, result.stderr);
  assert.match(result.stdout, /values were not read/);
});

test("production with a blank provider source rejects a missing billing rate before mutation", () => {
  const result = preflight({ names: ["CARTESIA_API_KEY"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CARTESIA_STT_USD_PER_CREDIT/);
});

test("queued key and positive billing rate can initialize a Cartesia deployment", () => {
  const result = preflight({ provider: "cartesia", key: "fixture-only", rate: "0.001" });
  assert.equal(result.status, 77, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-only|0\.001/);
});

test("invalid configured billing rates fail without printing their values", () => {
  for (const rate of ["0", "-1", "Infinity", "not-a-private-rate"]) {
    const result = preflight({ rate });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be positive and finite/);
    assert.doesNotMatch(result.stdout + result.stderr, /not-a-private-rate|Infinity/);
  }
});

test("staging only requires batch billing when Cartesia is explicitly selected", () => {
  assert.equal(preflight({ environment: "staging" }).status, 77);
  const selected = preflight({ environment: "staging", provider: "cartesia" });
  assert.equal(selected.status, 1);
  assert.match(selected.stderr, /CARTESIA_STT_USD_PER_CREDIT/);
});

test("billing rate is preserved rather than passed to the toggle deletion loop", () => {
  const toggleLoop = source.slice(source.indexOf("# Routing toggles:"), source.indexOf("# Preserve the production fail-closed boundary"));
  assert.doesNotMatch(toggleLoop, /CARTESIA_STT_USD_PER_CREDIT/);
  const managedLoop = source.slice(source.lastIndexOf("for name in", source.indexOf("  OPENROUTER_API_KEY")), source.indexOf("# Routing toggles:"));
  assert.match(managedLoop, /CARTESIA_STT_USD_PER_CREDIT/);
});


test("full preparation preserves existing Cartesia key and rate when protected sources are blank", () => {
  const root = mkdtempSync(join(tmpdir(), "cartesia-full-prepare-"));
  const originalNames = [
    "CARTESIA_API_KEY", "CARTESIA_STT_USD_PER_CREDIT",
    "VOICE_REALTIME_CARTESIA_VOICE_ID", "VOICE_REALTIME_ELIZA_AUTHORIZATION",
    "VOICE_REALTIME_ELIZA_ENDPOINT",
  ];
  try {
    const inventory = join(root, "inventory.json");
    const deletions = join(root, "deletions.json");
    const queued = join(root, "queued.json");
    writeFileSync(inventory, JSON.stringify(originalNames.map((name) => ({ name }))));
    writeFileSync(deletions, "[]");
    writeFileSync(join(root, "bunx"), `#!/bin/sh
[ "$1" = "wrangler@4.116.0" ] && [ "$2" = "secret" ] && [ "$3" = "list" ] || exit 91
cat "$FIXTURE_INVENTORY"
`);
    writeFileSync(join(root, "node"), `#!/bin/sh
exec "$FIXTURE_NODE" "$FIXTURE_DRIVER" "$@"
`);
    // Only external CLI boundaries are mocked. All shell queue/deletion logic
    // and the existing name verifier execute unchanged; no network is allowed.
    writeFileSync(join(root, "driver.cjs"), `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const name = path.basename(args[0] || "");
if (name === "ensure-worker-secret-absent.ts") {
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
`);
    chmodSync(join(root, "bunx"), 0o700);
    chmodSync(join(root, "node"), 0o700);
    const env: Record<string, string> = {};
    // Empty optional settings simulate a protected environment which cannot
    // recover the existing secrets; never inherit actual host credentials.
    for (const match of source.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)) env[match[1]] = "";
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
      DEPLOY_ENVIRONMENT: "production",
      VOICE_REALTIME_WS_ENABLED: "true",
      OPENROUTER_API_KEY: "fixture-model",
      ELIZA_APP_TELEGRAM_BOT_TOKEN: "fixture-telegram",
      ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "fixture-webhook",
      ELIZA_APP_BLOOIO_API_KEY: "fixture-blooio",
      ELIZA_APP_BLOOIO_PHONE_NUMBER: "fixture-number",
      ELIZA_APP_BLOOIO_WEBHOOK_SECRET: "fixture-blooio-webhook",
    });
    const result = spawnSync("bash", [script], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const deletedNames = JSON.parse(readFileSync(deletions, "utf8"));
    const remainingNames = JSON.parse(readFileSync(inventory, "utf8")).map((entry: { name: string }) => entry.name);
    const queuedNames = JSON.parse(readFileSync(queued, "utf8"));
    for (const name of ["CARTESIA_API_KEY", "CARTESIA_STT_USD_PER_CREDIT"]) {
      assert.ok(!deletedNames.includes(name), `${name} was deleted`);
      assert.ok(remainingNames.includes(name), `${name} disappeared`);
      assert.ok(!queuedNames.includes(name), `${name} was replaced despite its blank source`);
    }
    assert.match(readFileSync(join(root, "github-output"), "utf8"), /secrets_file=/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("caller passes the billing secret through the reusable workflow into preparation", () => {
  const caller = readFileSync(join(checkout, ".github/workflows/cloud-cf-deploy.yml"), "utf8");
  const callee = readFileSync(join(checkout, ".github/workflows/cloud-cf-release.yml"), "utf8");
  assert.match(caller, /CARTESIA_STT_USD_PER_CREDIT: \$\{\{ secrets\.CARTESIA_STT_USD_PER_CREDIT \}\}/);
  assert.match(callee, /CARTESIA_STT_USD_PER_CREDIT:\n        required: false/);
  assert.match(callee, /CARTESIA_STT_USD_PER_CREDIT: \$\{\{ vars\.CARTESIA_STT_USD_PER_CREDIT \|\| secrets\.CARTESIA_STT_USD_PER_CREDIT \}\}/);
});
