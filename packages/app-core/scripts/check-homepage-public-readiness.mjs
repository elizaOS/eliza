#!/usr/bin/env node
/**
 * Check whether the public eliza.app entry point is ready for the shared
 * Eliza Cloud phone gateway.
 *
 * This is intentionally read-only. It verifies the deploy target, DNS records,
 * and the published GitHub Pages bundle that users hit before texting the
 * shared gateway number.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const repo = "elizaOS/elizaos.github.io";
const expectedDomain = "eliza.app";
const expectedGatewayNumber = "+14159611510";
const expectedFormattedNumber = "+1 (415) 961-1510";
const disallowedNumbers = ["+14153024399", "4153024399", "415-302-4399"];
const expectedApexRecords = new Set([
  "185.199.108.153",
  "185.199.109.153",
  "185.199.110.153",
  "185.199.111.153",
]);
const expectedWwwCname = "elizaos.github.io.";
const registryRdapUrl = `https://pubapi.registry.google/rdap/domain/${expectedDomain}`;
const defaultEvidencePath = path.join(
  repoRoot,
  ".eliza-local",
  "homepage-public-readiness-latest.json",
);

function usage() {
  return [
    "Usage: node packages/app-core/scripts/check-homepage-public-readiness.mjs [options]",
    "",
    "Options:",
    "  --evidence <path>  Write structured proof JSON. Defaults to .eliza-local/homepage-public-readiness-latest.json.",
    "  --no-evidence      Do not write a proof JSON file.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    evidencePath: defaultEvidencePath,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--evidence") args.evidencePath = path.resolve(next());
    else if (arg === "--no-evidence") args.evidencePath = null;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return args;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const evidenceChecks = [];

function check(name, passed, detail) {
  evidenceChecks.push({ name, passed, detail });
  console.log(
    `[homepage-public] ${passed ? "PASS" : "BLOCKED"} ${name}: ${detail}`,
  );
  return passed;
}

function ghJson(path, jq) {
  const args = ["api", path];
  if (jq) args.push("--jq", jq);
  let lastResult = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = run("gh", args);
    if (lastResult.status === 0) return lastResult.stdout.trim();
    if (attempt < 3) sleepSync(500 * attempt);
  }
  throw new Error(
    lastResult?.stderr.trim() || lastResult?.stdout.trim() || "gh api failed",
  );
}

function decodeGhContent(path) {
  const content = ghJson(path, ".content");
  return Buffer.from(content, "base64").toString("utf8");
}

function dig(name, type = null) {
  const args = ["+short"];
  if (type) args.push(type);
  args.push(name);
  const result = run("dig", args);
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function fetchJson(url) {
  const result = run("curl", ["-sS", "--max-time", "10", url]);
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "curl failed",
    );
  }
  return JSON.parse(result.stdout);
}

function setEquals(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function findJsAssets() {
  const output = ghJson(
    `repos/${repo}/git/trees/gh-pages?recursive=1`,
    ".tree[].path",
  );
  return output
    .split(/\r?\n/)
    .filter((path) =>
      /^assets\/(get-started|connected|contact)-.*\.js$/.test(path),
    );
}

function writeEvidence({ evidencePath, ok, next, details }) {
  if (!evidencePath) return;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const evidence = {
    ok,
    checkedAt: new Date().toISOString(),
    domain: expectedDomain,
    expectedGatewayNumber,
    expectedFormattedNumber,
    expectedApexRecords: [...expectedApexRecords],
    expectedWwwCname,
    checks: evidenceChecks,
    next: next ?? null,
    details,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[homepage-public] evidence=${evidencePath}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let allPassed = true;
  let pagesSummary = null;
  let assetSummary = null;

  try {
    const pages = JSON.parse(
      ghJson(
        `repos/${repo}/pages`,
        "{status,cname,html_url,source,protected_domain_state,pending_domain_unverified_at}",
      ),
    );
    allPassed =
      check(
        "pages-source",
        pages.status === "built" &&
          pages.cname === expectedDomain &&
          pages.source?.branch === "gh-pages" &&
          pages.source?.path === "/",
        `status=${pages.status} cname=${pages.cname ?? "none"} source=${pages.source?.branch ?? "none"}:${pages.source?.path ?? "none"}`,
      ) && allPassed;
    pagesSummary = pages;
  } catch (error) {
    allPassed =
      check(
        "pages-source",
        false,
        error instanceof Error ? error.message : String(error),
      ) && allPassed;
  }

  try {
    const cname = decodeGhContent(
      `repos/${repo}/contents/CNAME?ref=gh-pages`,
    ).trim();
    allPassed =
      check(
        "gh-pages-cname",
        cname === expectedDomain,
        `CNAME=${cname || "empty"}`,
      ) && allPassed;
  } catch (error) {
    allPassed =
      check(
        "gh-pages-cname",
        false,
        error instanceof Error ? error.message : String(error),
      ) && allPassed;
  }

  try {
    const assets = findJsAssets();
    if (!assets.some((asset) => /^assets\/get-started-.*\.js$/.test(asset))) {
      throw new Error("no get-started asset found on gh-pages");
    }
    const bundle = assets
      .map((asset) =>
        decodeGhContent(`repos/${repo}/contents/${asset}?ref=gh-pages`),
      )
      .join("\n");
    const hasGateway =
      bundle.includes(expectedGatewayNumber) &&
      bundle.includes(expectedFormattedNumber);
    const hasPersonalNumber = disallowedNumbers.some((value) =>
      bundle.includes(value),
    );
    assetSummary = {
      count: assets.length,
      assets,
      hasGateway,
      hasPersonalNumber,
    };
    allPassed =
      check(
        "homepage-bundle",
        hasGateway && !hasPersonalNumber,
        `${assets.length} js assets gateway=${hasGateway ? "yes" : "no"} personal-number=${hasPersonalNumber ? "yes" : "no"}`,
      ) && allPassed;
  } catch (error) {
    allPassed =
      check(
        "homepage-bundle",
        false,
        error instanceof Error ? error.message : String(error),
      ) && allPassed;
  }

  const delegatedNameservers = dig(expectedDomain, "NS");
  let registryStatuses = [];
  let registryNameservers = [];
  try {
    const rdap = fetchJson(registryRdapUrl);
    registryStatuses = Array.isArray(rdap.status) ? rdap.status : [];
    registryNameservers = Array.isArray(rdap.nameservers)
      ? rdap.nameservers
          .map((entry) =>
            typeof entry?.ldhName === "string"
              ? entry.ldhName.toLowerCase()
              : "",
          )
          .filter(Boolean)
      : [];
    const clientHold = registryStatuses.includes("client hold");
    allPassed =
      check(
        "registry-status",
        !clientHold,
        registryStatuses.length
          ? registryStatuses.join(", ")
          : "no status flags",
      ) && allPassed;
  } catch (error) {
    allPassed =
      check(
        "registry-status",
        false,
        error instanceof Error ? error.message : String(error),
      ) && allPassed;
  }

  allPassed =
    check(
      "domain-delegation",
      delegatedNameservers.length > 0,
      delegatedNameservers.length
        ? delegatedNameservers.join(", ")
        : registryNameservers.length
          ? `registry lists ${registryNameservers.join(", ")} but delegation is withheld`
          : "no delegated nameservers at .app registry",
    ) && allPassed;

  const apexRecords = new Set(dig(expectedDomain));
  allPassed =
    check(
      "apex-dns",
      setEquals(apexRecords, expectedApexRecords),
      apexRecords.size ? [...apexRecords].join(", ") : "no A records",
    ) && allPassed;

  const wwwCnames = dig(`www.${expectedDomain}`, "CNAME");
  allPassed =
    check(
      "www-dns",
      wwwCnames.includes(expectedWwwCname),
      wwwCnames.length ? wwwCnames.join(", ") : "no CNAME records",
    ) && allPassed;

  if (!allPassed) {
    const dnsRecordInstructions =
      `A ${expectedDomain} -> ${[...expectedApexRecords].join(", ")}; ` +
      `CNAME www.${expectedDomain} -> ${expectedWwwCname}`;
    const next = registryStatuses.includes("client hold")
      ? `clear client hold at Porkbun/registrar, then add GitHub Pages DNS records (${dnsRecordInstructions}). With Porkbun API credentials, run: bun run --cwd packages/app-core sms-gateway:homepage:dns -- --apply. Then rerun this script.`
      : `delegate eliza.app to DNS nameservers, add GitHub Pages DNS records (${dnsRecordInstructions}). With Porkbun API credentials, run: bun run --cwd packages/app-core sms-gateway:homepage:dns -- --apply. Then rerun this script.`;
    console.error(`[homepage-public] next: ${next}`);
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      next,
      details: {
        pages: pagesSummary,
        assets: assetSummary,
        registryStatuses,
        registryNameservers,
        delegatedNameservers,
        apexRecords: [...apexRecords],
        wwwCnames,
      },
    });
    process.exitCode = 1;
    return;
  }

  writeEvidence({
    evidencePath: args.evidencePath,
    ok: true,
    next: null,
    details: {
      pages: pagesSummary,
      assets: assetSummary,
      registryStatuses,
      registryNameservers,
      delegatedNameservers,
      apexRecords: [...apexRecords],
      wwwCnames,
    },
  });
}

try {
  main();
} catch (error) {
  console.error(
    `[homepage-public] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
