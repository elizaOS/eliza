#!/usr/bin/env node
/**
 * Audits the published DNS mail-security posture of the Eliza Research company
 * domain so the Workspace baseline stays verifiable outside the admin console.
 *
 * The evaluation is a pure function over already-resolved records, which keeps
 * the contract testable without network access; the CLI wrapper resolves live
 * DNS and exits non-zero when any required control fails. Only public DNS is
 * inspected — recovery paths, alias membership, and 2-Step Verification custody
 * live in the Workspace admin console and are covered by MAIL-SECURITY.md.
 */

import { createPublicKey } from "node:crypto";
import { Resolver } from "node:dns/promises";

export const DEFAULT_DOMAIN = "elizaresearch.ai";
export const DKIM_SELECTOR = "google";

const GOOGLE_MX_HOST = "smtp.google.com";
const MIN_DKIM_MODULUS_BITS = 2048;

/**
 * Joins the character-string chunks a resolver returns for one TXT record.
 * DNS splits strings longer than 255 bytes, which is routine for DKIM keys.
 */
function flattenTxt(record) {
  return Array.isArray(record) ? record.join("") : String(record);
}

function parseDmarcTags(txt) {
  const tags = new Map();
  for (const part of txt.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    tags.set(
      trimmed.slice(0, separator).trim().toLowerCase(),
      trimmed.slice(separator + 1).trim(),
    );
  }
  return tags;
}

function checkMx(mx) {
  if (mx.length === 0) {
    return { id: "mx", ok: false, detail: "no MX records are published" };
  }
  const nonGoogle = mx
    .map((entry) => entry.exchange.replace(/\.$/u, "").toLowerCase())
    .filter((host) => host !== GOOGLE_MX_HOST && !host.endsWith(".google.com"));
  if (nonGoogle.length > 0) {
    return {
      id: "mx",
      ok: false,
      detail: `unexpected MX hosts route mail away from Workspace: ${nonGoogle.join(", ")}`,
    };
  }
  return { id: "mx", ok: true, detail: `${mx.length} Google MX host(s)` };
}

function checkSpf(txt) {
  const spf = txt.filter((value) => value.toLowerCase().startsWith("v=spf1"));
  if (spf.length === 0) {
    return { id: "spf", ok: false, detail: "no v=spf1 record is published" };
  }
  if (spf.length > 1) {
    return {
      id: "spf",
      ok: false,
      detail: `${spf.length} SPF records are published; exactly one is authoritative`,
    };
  }
  const record = spf[0];
  // Mechanism names and domains are case-insensitive (RFC 7208 s4.6.1), so a
  // valid "Include:_SPF.Google.com" must not read as unauthorized.
  const mechanisms = record.trim().split(/\s+/u).slice(1);
  if (
    !mechanisms.some(
      (mechanism) => mechanism.toLowerCase() === "include:_spf.google.com",
    )
  ) {
    return {
      id: "spf",
      ok: false,
      detail: "the SPF record does not authorize Google Workspace senders",
    };
  }
  // Evaluation stops at the first matching mechanism, so only the LAST one
  // decides the fate of an otherwise-unmatched sender. Matching "~all"
  // anywhere would pass a record like "... ~all include:evil.com +all",
  // whose real terminal mechanism authorizes the whole internet.
  const terminal = mechanisms.at(-1)?.toLowerCase() ?? "";
  if (terminal !== "~all" && terminal !== "-all") {
    return {
      id: "spf",
      ok: false,
      detail: "the SPF record must end in ~all or -all, not ?all or +all",
    };
  }
  return { id: "spf", ok: true, detail: record };
}

function checkDkim(txt) {
  const keys = txt.filter((value) => value.toLowerCase().startsWith("v=dkim1"));
  if (keys.length === 0) {
    return {
      id: "dkim",
      ok: false,
      detail: `no DKIM key is published at ${DKIM_SELECTOR}._domainkey`,
    };
  }
  if (keys.length > 1) {
    return {
      id: "dkim",
      ok: false,
      detail: `${keys.length} DKIM keys share the ${DKIM_SELECTOR} selector`,
    };
  }
  const publicKey = /(?:^|;)\s*p=([^;]*)/u.exec(keys[0])?.[1]?.trim() ?? "";
  if (publicKey.length === 0) {
    return {
      id: "dkim",
      ok: false,
      detail: "the DKIM record has an empty p= tag (revoked key)",
    };
  }
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(publicKey) ||
    publicKey.length % 4 === 1
  ) {
    return {
      id: "dkim",
      ok: false,
      detail: "the DKIM p= tag is not strict base64",
    };
  }
  const paddedPublicKey = publicKey.padEnd(
    publicKey.length + ((4 - (publicKey.length % 4)) % 4),
    "=",
  );
  const der = Buffer.from(paddedPublicKey, "base64");
  if (
    der.length === 0 ||
    der.toString("base64").replace(/=+$/u, "") !== publicKey.replace(/=+$/u, "")
  ) {
    return {
      id: "dkim",
      ok: false,
      detail: "the DKIM p= tag is not canonical base64",
    };
  }
  let key;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
    // error-policy:J3 malformed public key material is an explicit failed DNS control.
  } catch {
    return {
      id: "dkim",
      ok: false,
      detail: "the DKIM p= tag is not a valid DER SubjectPublicKeyInfo key",
    };
  }
  if (key.asymmetricKeyType !== "rsa") {
    return {
      id: "dkim",
      ok: false,
      detail: `the DKIM key algorithm is ${key.asymmetricKeyType ?? "unknown"}, not RSA`,
    };
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (
    typeof modulusLength !== "number" ||
    modulusLength < MIN_DKIM_MODULUS_BITS
  ) {
    return {
      id: "dkim",
      ok: false,
      detail: `the DKIM RSA modulus is ${modulusLength ?? "unknown"} bits; at least ${MIN_DKIM_MODULUS_BITS} are required`,
    };
  }
  return {
    id: "dkim",
    ok: true,
    detail: `${modulusLength}-bit RSA key on selector ${DKIM_SELECTOR}`,
  };
}

function checkDmarc(txt) {
  const records = txt.filter((value) =>
    value.toLowerCase().startsWith("v=dmarc1"),
  );
  if (records.length === 0) {
    return {
      id: "dmarc",
      ok: false,
      detail:
        "no DMARC policy is published at _dmarc; publish p=none monitor mode first",
    };
  }
  if (records.length > 1) {
    return {
      id: "dmarc",
      ok: false,
      detail: `${records.length} DMARC records are published; exactly one is valid`,
    };
  }
  const tags = parseDmarcTags(records[0]);
  const policy = (tags.get("p") ?? "").toLowerCase();
  if (!["none", "quarantine", "reject"].includes(policy)) {
    return {
      id: "dmarc",
      ok: false,
      detail: `the DMARC p= tag is missing or invalid: "${policy}"`,
    };
  }
  // rua is a comma-separated URI list (RFC 7489 s6.2). A substring test would
  // accept "notmailto:x" or a bare "mailto:" with no address, reporting a
  // destination that can never receive an aggregate report.
  const rua = tags.get("rua") ?? "";
  const hasReportDestination = rua
    .split(",")
    .map((uri) => uri.trim())
    .some((uri) => {
      if (!uri.toLowerCase().startsWith("mailto:")) return false;
      // Strip the optional "!size" limit suffix before validating the address.
      const address = uri.slice("mailto:".length).split("!")[0] ?? "";
      const [local, domain, ...rest] = address.split("@");
      return (
        rest.length === 0 &&
        (local?.length ?? 0) > 0 &&
        (domain?.length ?? 0) > 0 &&
        domain.includes(".")
      );
    });
  if (!hasReportDestination) {
    return {
      id: "dmarc",
      ok: false,
      detail: "the DMARC record has no rua= aggregate-report destination",
    };
  }
  return {
    id: "dmarc",
    ok: true,
    detail:
      policy === "none"
        ? "monitor mode (p=none) with an aggregate-report destination; review alignment before enforcing"
        : `enforcing policy p=${policy} with an aggregate-report destination`,
  };
}

/**
 * Evaluates one domain's resolved records against the mail-security baseline.
 * `records` carries `mx`, `txt`, `dkimTxt`, and `dmarcTxt`, each already
 * flattened to strings except `mx`, which keeps resolver `{ exchange }` shape.
 */
export function evaluateMailSecurity(records) {
  const checks = [
    checkMx(records.mx ?? []),
    checkSpf(records.txt ?? []),
    checkDkim(records.dkimTxt ?? []),
    checkDmarc(records.dmarcTxt ?? []),
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

async function resolveTxt(resolver, name) {
  try {
    return (await resolver.resolveTxt(name)).map(flattenTxt);
    // error-policy:J3 an absent record is a valid DNS answer, reported as a failed check below
  } catch (error) {
    if (error && (error.code === "ENOTFOUND" || error.code === "ENODATA"))
      return [];
    throw error;
  }
}

async function resolveMx(resolver, name) {
  try {
    return await resolver.resolveMx(name);
    // error-policy:J3 an absent record is a valid DNS answer, reported as a failed check below
  } catch (error) {
    if (error && (error.code === "ENOTFOUND" || error.code === "ENODATA"))
      return [];
    throw error;
  }
}

export async function resolveMailSecurityRecords(
  domain,
  resolver = new Resolver(),
) {
  const [mx, txt, dkimTxt, dmarcTxt] = await Promise.all([
    resolveMx(resolver, domain),
    resolveTxt(resolver, domain),
    resolveTxt(resolver, `${DKIM_SELECTOR}._domainkey.${domain}`),
    resolveTxt(resolver, `_dmarc.${domain}`),
  ]);
  return { mx, txt, dkimTxt, dmarcTxt };
}

async function main() {
  const domain = process.argv[2] ?? DEFAULT_DOMAIN;
  const report = evaluateMailSecurity(await resolveMailSecurityRecords(domain));
  console.log(`mail-security baseline for ${domain}`);
  for (const check of report.checks) {
    console.log(
      `  ${check.ok ? "PASS" : "FAIL"} ${check.id.padEnd(5)} ${check.detail}`,
    );
  }
  if (!report.ok) {
    console.log(
      "\nSee packages/elizaresearch/MAIL-SECURITY.md for the remediation runbook.",
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
