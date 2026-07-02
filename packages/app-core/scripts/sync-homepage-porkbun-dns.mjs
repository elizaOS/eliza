#!/usr/bin/env node
/**
 * Guarded Porkbun DNS helper for the public eliza.app homepage.
 *
 * Dry-run is the default. Passing --apply requires Porkbun API credentials and
 * only mutates the exact GitHub Pages records needed for eliza.app.
 */

const porkbunBaseUrl = "https://api.porkbun.com/api/json/v3";
const defaultDomain = "eliza.app";
const expectedApexRecords = [
  "185.199.108.153",
  "185.199.109.153",
  "185.199.110.153",
  "185.199.111.153",
];
const expectedWwwCname = "elizaos.github.io.";
const defaultTtl = "600";

function usage() {
  return [
    "Usage: node packages/app-core/scripts/sync-homepage-porkbun-dns.mjs [options]",
    "",
    "Options:",
    "  --domain <domain>         Domain to manage. Defaults to eliza.app.",
    "  --apply                   Apply the plan. Defaults to dry-run.",
    "  --api-key <key>           Porkbun API key. Defaults to PORKBUN_API_KEY.",
    "  --secret-api-key <key>    Porkbun secret API key. Defaults to PORKBUN_SECRET_API_KEY or PORKBUN_SECRET_KEY.",
    "  --api-base <url>          Porkbun API base URL. Defaults to production Porkbun.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    domain: defaultDomain,
    apply: false,
    apiKey: process.env.PORKBUN_API_KEY || "",
    secretApiKey:
      process.env.PORKBUN_SECRET_API_KEY ||
      process.env.PORKBUN_SECRET_KEY ||
      "",
    apiBase: process.env.PORKBUN_API_BASE || porkbunBaseUrl,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--domain") args.domain = next().toLowerCase();
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--api-key") args.apiKey = next();
    else if (arg === "--secret-api-key") args.secretApiKey = next();
    else if (arg === "--api-base") args.apiBase = next().replace(/\/$/, "");
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (args.domain !== defaultDomain) {
    throw new Error(
      `Refusing to manage ${args.domain}; this helper is scoped to ${defaultDomain}.`,
    );
  }
  return args;
}

function authBody(args, extra = {}) {
  return {
    apikey: args.apiKey,
    secretapikey: args.secretApiKey,
    ...extra,
  };
}

async function postPorkbun(args, path, body = {}) {
  if (!args.apiKey || !args.secretApiKey) {
    throw new Error(
      "Porkbun API credentials are required. Set PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY.",
    );
  }

  const response = await fetch(`${args.apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(authBody(args, body)),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok || parsed.status !== "SUCCESS") {
    throw new Error(`${path} failed (${response.status}): ${text}`);
  }
  return parsed;
}

function printDesiredRecordsWithoutCredentials() {
  for (const content of expectedApexRecords) {
    console.log(`[homepage-porkbun-dns] desired: A @ ${content}`);
  }
  console.log(`[homepage-porkbun-dns] desired: CNAME www ${expectedWwwCname}`);
  console.log(
    "[homepage-porkbun-dns] no Porkbun credentials found; set PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY to compare or apply.",
  );
}

function normalizeRecordName(record, domain) {
  const name = String(record.name ?? "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!name || name === domain) return "";
  if (name.endsWith(`.${domain}`)) return name.slice(0, -(domain.length + 1));
  return name;
}

function normalizeContent(record) {
  return String(record.content ?? "").trim();
}

function isApexA(record, domain) {
  return record.type === "A" && normalizeRecordName(record, domain) === "";
}

function isWwwCname(record, domain) {
  return (
    record.type === "CNAME" && normalizeRecordName(record, domain) === "www"
  );
}

function desiredApexRecordsPresent(records, domain) {
  const current = new Set(
    records.filter((record) => isApexA(record, domain)).map(normalizeContent),
  );
  return expectedApexRecords.every((value) => current.has(value));
}

function desiredWwwRecordPresent(records, domain) {
  return records
    .filter((record) => isWwwCname(record, domain))
    .some((record) => normalizeContent(record) === expectedWwwCname);
}

function buildPlan(records, domain) {
  const plan = [];
  const wantedApex = new Set(expectedApexRecords);
  const seenApex = new Set();
  for (const record of records.filter((entry) => isApexA(entry, domain))) {
    const content = normalizeContent(record);
    if (wantedApex.has(content) && !seenApex.has(content)) {
      seenApex.add(content);
      continue;
    }
    plan.push({
      action: "delete",
      id: record.id,
      type: "A",
      name: "",
      content,
      reason: wantedApex.has(content)
        ? "duplicate apex A"
        : "unexpected apex A",
    });
  }
  for (const content of expectedApexRecords) {
    if (!seenApex.has(content)) {
      plan.push({
        action: "create",
        type: "A",
        name: "",
        content,
        ttl: defaultTtl,
      });
    }
  }

  let keptWww = false;
  for (const record of records.filter((entry) => isWwwCname(entry, domain))) {
    const content = normalizeContent(record);
    if (content === expectedWwwCname && !keptWww) {
      keptWww = true;
      continue;
    }
    plan.push({
      action: "delete",
      id: record.id,
      type: "CNAME",
      name: "www",
      content,
      reason:
        content === expectedWwwCname
          ? "duplicate www CNAME"
          : "unexpected www CNAME",
    });
  }
  if (!keptWww) {
    plan.push({
      action: "create",
      type: "CNAME",
      name: "www",
      content: expectedWwwCname,
      ttl: defaultTtl,
    });
  }

  return plan;
}

function printPlan(plan) {
  if (plan.length === 0) {
    console.log("[homepage-porkbun-dns] plan: no changes needed");
    return;
  }
  for (const item of plan) {
    const name = item.name || "@";
    const reason = item.reason ? ` reason=${item.reason}` : "";
    console.log(
      `[homepage-porkbun-dns] plan: ${item.action} ${item.type} ${name} ${item.content}${reason}`,
    );
  }
}

async function applyPlan(args, plan) {
  for (const item of plan) {
    if (item.action === "delete") {
      await postPorkbun(args, `/dns/delete/${args.domain}/${item.id}`);
      console.log(
        `[homepage-porkbun-dns] applied: deleted ${item.type} ${item.name || "@"} ${item.content}`,
      );
    } else if (item.action === "create") {
      await postPorkbun(args, `/dns/create/${args.domain}`, {
        type: item.type,
        name: item.name,
        content: item.content,
        ttl: item.ttl,
      });
      console.log(
        `[homepage-porkbun-dns] applied: created ${item.type} ${item.name || "@"} ${item.content}`,
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.apiKey || !args.secretApiKey) {
    if (args.apply) {
      throw new Error(
        "Porkbun API credentials are required. Set PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY.",
      );
    }
    printDesiredRecordsWithoutCredentials();
    console.log(
      "[homepage-porkbun-dns] dry-run only. No DNS changes were attempted.",
    );
    return;
  }

  const body = await postPorkbun(args, `/dns/retrieve/${args.domain}`);
  const records = Array.isArray(body.records) ? body.records : [];
  const plan = buildPlan(records, args.domain);
  printPlan(plan);

  if (!args.apply) {
    console.log(
      "[homepage-porkbun-dns] dry-run only. Pass --apply to mutate Porkbun DNS.",
    );
    return;
  }

  await applyPlan(args, plan);
  const after = await postPorkbun(args, `/dns/retrieve/${args.domain}`);
  const afterRecords = Array.isArray(after.records) ? after.records : [];
  if (
    !desiredApexRecordsPresent(afterRecords, args.domain) ||
    !desiredWwwRecordPresent(afterRecords, args.domain)
  ) {
    throw new Error("Porkbun DNS sync did not produce the expected records.");
  }
  console.log(
    "[homepage-porkbun-dns] PASS Porkbun DNS records match GitHub Pages target.",
  );
}

main().catch((error) => {
  console.error(
    `[homepage-porkbun-dns] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
