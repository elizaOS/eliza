#!/usr/bin/env node
/**
 * Stage real Eliza-1 bundle artifacts into
 * `$ELIZA_STATE_DIR/local-inference/models/eliza-1-<tier>.bundle/`.
 *
 * Source-of-truth contract:
 *   1. The bundle's `eliza-1.manifest.json` is the binding contract.
 *   2. Every entry in `manifest.files.<category>[]` MUST exist on disk and
 *      its SHA-256 MUST match the manifest exactly. Stubs (zero-byte or
 *      placeholder GGUFs) are NEVER tolerated.
 *   3. Missing/mismatched artifacts are downloaded from
 *      `https://huggingface.co/elizaos/eliza-1` under
 *      `bundles/<tier>/<path>`. No HF token required for the public repo.
 *   4. The DFlash release-policy is honored: a bundle whose
 *      `dflash/dflash-disabled-<tier>.release-policy.json` is present and
 *      flags `requiresDrafter=false` MUST NOT contain `dflash/drafter-*.gguf`.
 *      Any such forbidden artifact is moved to the bundle's `.quarantine/`.
 *
 * Exit codes:
 *   0  every manifest entry validated, no stub remains.
 *   1  any artifact still missing after download attempts, OR a
 *      forbidden artifact remains, OR the manifest is malformed.
 *
 * Usage:
 *   node scripts/stage-bundle.mjs <tier>
 *   node scripts/stage-bundle.mjs --all
 *
 * Tier names: 0_6b | 0_8b | 1_7b | 2b | 4b | 9b | 27b | 27b-256k
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HF_REPO = "elizaos/eliza-1";
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;
const KNOWN_TIERS = [
  "0_6b",
  "0_8b",
  "1_7b",
  "2b",
  "4b",
  "9b",
  "27b",
  "27b-256k",
];

function stateDir() {
  return (
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza")
  );
}

function bundleDir(tier) {
  return path.join(
    stateDir(),
    "local-inference",
    "models",
    `eliza-1-${tier}.bundle`,
  );
}

function readManifest(dir) {
  const p = path.join(dir, "eliza-1.manifest.json");
  if (!fs.existsSync(p)) {
    throw new Error(`missing manifest: ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function sha256(filePath) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
    h.update(buf.subarray(0, n));
  }
  fs.closeSync(fd);
  return h.digest("hex");
}

function downloadFromHF(tier, relPath, dest) {
  const url = `${HF_BASE}/bundles/${tier}/${relPath}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Stream straight to disk — no body buffering. -L follows the Xet redirect.
  const result = spawnSync(
    "curl",
    ["-fL", "--retry", "3", "--retry-delay", "2", "-o", dest, url],
    {
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `curl exit ${result.status} fetching ${url}`,
    };
  }
  return { ok: true };
}

function quarantine(bundleRoot, relPath) {
  const src = path.join(bundleRoot, relPath);
  if (!fs.existsSync(src)) return null;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const qDir = path.join(bundleRoot, ".quarantine", stamp);
  fs.mkdirSync(qDir, { recursive: true });
  const dest = path.join(qDir, path.basename(relPath));
  fs.renameSync(src, dest);
  return dest;
}

function loadDisablePolicy(bundleRoot, tier) {
  const policyPath = path.join(
    bundleRoot,
    "dflash",
    `dflash-disabled-${tier}.release-policy.json`,
  );
  if (!fs.existsSync(policyPath)) return null;
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  return policy?.kind === "dflash-release-policy" &&
    policy.status === "disabled"
    ? policy
    : null;
}

function stageBundle(tier) {
  const root = bundleDir(tier);
  if (!fs.existsSync(root)) {
    return {
      tier,
      ok: false,
      reason: `bundle dir missing: ${root}`,
      changed: [],
      verified: [],
      quarantined: [],
    };
  }
  const manifest = readManifest(root);
  const policy = loadDisablePolicy(root, tier);
  const forbidden = new Set(
    policy?.expectedBundleFiles?.forbidden ?? [],
  );

  const changed = [];
  const verified = [];
  const quarantined = [];
  const failures = [];

  // Pass 1: enforce forbidden
  for (const rel of forbidden) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
      const moved = quarantine(root, rel);
      quarantined.push({ from: rel, to: moved });
    }
  }

  // Pass 2: validate / fetch every manifest entry
  for (const [category, entries] of Object.entries(manifest.files ?? {})) {
    for (const entry of entries) {
      const abs = path.join(root, entry.path);
      const want = entry.sha256;
      const stage = (reason) => {
        const result = downloadFromHF(tier, entry.path, abs);
        if (!result.ok) {
          failures.push(`${entry.path}: ${reason}; ${result.reason}`);
          return;
        }
        const got = sha256(abs);
        if (got !== want) {
          failures.push(
            `${entry.path}: ${reason}; downloaded SHA mismatch want=${want} got=${got}`,
          );
          return;
        }
        changed.push({ path: entry.path, category, sha256: got });
      };

      if (!fs.existsSync(abs)) {
        stage("missing");
        continue;
      }
      const got = sha256(abs);
      if (got !== want) {
        stage(`SHA mismatch want=${want} got=${got}`);
        continue;
      }
      verified.push({ path: entry.path, category, sha256: got });
    }
  }

  return {
    tier,
    ok: failures.length === 0,
    failures,
    changed,
    verified,
    quarantined,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "usage: node scripts/stage-bundle.mjs <tier>|--all\n" +
        `  tiers: ${KNOWN_TIERS.join(" | ")}`,
    );
    process.exit(2);
  }
  const tiers = args[0] === "--all" ? KNOWN_TIERS : [args[0]];
  let allOk = true;
  for (const tier of tiers) {
    if (!KNOWN_TIERS.includes(tier)) {
      console.error(`unknown tier '${tier}'`);
      allOk = false;
      continue;
    }
    process.stdout.write(`[stage-bundle] ${tier}: validating...\n`);
    const r = stageBundle(tier);
    if (!fs.existsSync(bundleDir(tier))) {
      console.error(
        `[stage-bundle] ${tier}: SKIP (bundle dir not present locally)`,
      );
      continue;
    }
    const summary = {
      tier: r.tier,
      ok: r.ok,
      verifiedCount: r.verified.length,
      changedCount: r.changed.length,
      quarantinedCount: r.quarantined.length,
      failures: r.failures,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

main();
