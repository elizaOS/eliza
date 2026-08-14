#!/usr/bin/env node
/**
 * Check whether the public eliza.app entry point is ready for the shared
 * Eliza Cloud phone gateway.
 *
 * This is intentionally read-only. It verifies the live Cloudflare deployment,
 * DNS records, and the published homepage content that users hit before texting
 * or calling the shared gateway number.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const expectedDomain = "eliza.app";
const expectedGatewayNumber = "+18087881821";
const expectedFormattedNumber = "+1 (808) 788-1821";
const disallowedNumbers = ["+14159611510", "+1 (415) 961-1510", "4159611510", "415-961-1510", "+14153024399", "4153024399", "415-302-4399"];
const cloudflarePageRuleIps = new Set([
  "104.16.0.0/12", // Cloudflare IP range (simplified for A record checks)
]);
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

function setEquals(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
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

function fetchHomepageContent() {
  const result = run("curl", ["-sS", "--max-time", "10", `https://${expectedDomain}`]);
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "curl failed",
    );
  }
  return result.stdout;
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

function fetchHomepageContent() {
  const result = run("curl", ["-sS", "--max-time", "10", `https://${expectedDomain}`]);
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "curl failed",
    );
  }
  return result.stdout;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let allPassed = true;
  let cloudflareCheckSummary = null;
  let homepageContentSummary = null;

  try {
    const homepageHtml = fetchHomepageContent();
    const hasGatewayNumber =
      homepageHtml.includes(expectedGatewayNumber) &&
      homepageHtml.includes(expectedFormattedNumber);
    const hasDisallowedNumbers = disallowedNumbers.some((value) =>
      homepageHtml.includes(value),
    );
    const hasFormattedPhoneNumbers = /\+\s*1\s*\(\s*\d{3}\s*\)\s*\d{3}\s*-\s*\d{4}/.test(homepageHtml);

    homepageContentSummary = {
      hasGatewayNumber,
      hasDisallowedNumbers,
      hasFormattedPhoneNumbers,
    };

    allPassed =
      check(
        "cloudflare-homepage-content",
        hasGatewayNumber && !hasDisallowedNumbers && !hasFormattedPhoneNumbers,
        `gateway=${hasGatewayNumber ? "yes" : "no"} disallowed-numbers=${hasDisallowedNumbers ? "yes" : "no"} formatted-numbers=${hasFormattedPhoneNumbers ? "yes" : "no"}`,
      ) && allPassed;
  } catch (error) {
    allPassed =
      check(
        "cloudflare-homepage-content",
        false,
        error instanceof Error ? error.message : String(error),
      ) && allPassed;
  }

  try {
    const cloudflareCheckResult = run("curl", ["-sI", "--max-time", "10", `https://${expectedDomain}`]);
    if (cloudflareCheckResult.status === 0) {
      const headers = cloudflareCheckResult.stdout;
      const isCloudflareServed = headers.includes("cf-ray") || headers.includes("server: cloudflare");
      cloudflareCheckSummary = { isCloudflareServed, headers };
      allPassed =
        check(
          "cloudflare-server",
          isCloudflareServed,
          isCloudflareServed ? "served by Cloudflare" : "not identified as Cloudflare-served",
        ) && allPassed;
    } else {
      throw new Error("Failed to check HTTP headers");
    }
  } catch (error) {
    allPassed =
      check(
        "cloudflare-server",
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
      apexRecords.size > 0,
      apexRecords.size ? [...apexRecords].join(", ") : "no A records",
    ) && allPassed;

  if (!allPassed) {
    const next = registryStatuses.includes("client hold")
      ? `clear client hold at Porkbun/registrar. Ensure eliza.app DNS resolves to Cloudflare nameservers and homepage at https://eliza.app displays the correct gateway number ${expectedGatewayNumber}. Rerun this script.`
      : `ensure eliza.app domain delegation and DNS are correctly configured to point to Cloudflare. Verify https://eliza.app is served from Cloudflare and contains the correct gateway number ${expectedGatewayNumber}. Rerun this script.`;
    console.error(`[homepage-public] next: ${next}`);
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      next,
      details: {
        cloudflareCheck: cloudflareCheckSummary,
        homepageContent: homepageContentSummary,
        registryStatuses,
        registryNameservers,
        delegatedNameservers,
        apexRecords: [...apexRecords],
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
      cloudflareCheck: cloudflareCheckSummary,
      homepageContent: homepageContentSummary,
      registryStatuses,
      registryNameservers,
      delegatedNameservers,
      apexRecords: [...apexRecords],
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
