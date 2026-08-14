#!/usr/bin/env node
/**
 * Validates the rendered public homepage against the admitted Cloudflare and
 * Blooio messaging configuration. The check is read-only and writes evidence
 * that distinguishes a disabled WhatsApp surface from a verified live sender.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const repo = "elizaOS/eliza";
const defaultOrigin = "https://eliza.app";
const expectedGatewayNumber = "+18087881821";
const expectedFormattedNumber = "+1 (808) 788-1821";
const rejectedWhatsAppNumbers = [
  "+14155238886",
  "+15551649988",
  "+14159611510",
];
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
    "  --origin <url>     Public origin. Defaults to https://eliza.app.",
    "  --evidence <path>  Write proof JSON. Defaults to .eliza-local/homepage-public-readiness-latest.json.",
    "  --no-evidence      Do not write a proof JSON file.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { evidencePath: defaultEvidencePath, origin: defaultOrigin };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--origin") args.origin = new URL(next()).origin;
    else if (arg === "--evidence") args.evidencePath = path.resolve(next());
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
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `${command} exited with ${result.status}`,
    );
  }
  return result.stdout.trim();
}

function getRepoVariables() {
  const rows = JSON.parse(
    run("gh", ["variable", "list", "--repo", repo, "--json", "name,value"]),
  );
  return Object.fromEntries(rows.map(({ name, value }) => [name, value]));
}

function normalizePhone(value) {
  const trimmed = value?.trim() ?? "";
  return /^\+[1-9]\d{7,14}$/.test(trimmed) ? trimmed : null;
}

export function resolveWhatsAppAdmission(value) {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (["", "0", "false", "no", "off"].includes(normalized)) {
    return { enabled: false, valid: true };
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return { enabled: true, valid: true };
  }
  return { enabled: false, valid: false };
}

export function evaluatePublicSurface(surface, config) {
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed, detail });
  };
  const expectedTelHref = `tel:${expectedGatewayNumber}`;
  const expectedWhatsAppHref = `https://wa.me/${expectedGatewayNumber.slice(1)}`;

  check(
    "cloudflare-origin",
    surface.server.toLowerCase() === "cloudflare",
    `server=${surface.server || "missing"}`,
  );
  check(
    "canonical-origin",
    surface.finalUrl === `${config.origin ?? defaultOrigin}/`,
    `url=${surface.finalUrl}`,
  );
  check(
    "message-copy-fallback",
    surface.messageButtonCount === 1 &&
      surface.copiedPhone === expectedGatewayNumber &&
      surface.copyNotice === "Phone number copied",
    `buttons=${surface.messageButtonCount} clipboard=${surface.copiedPhone || "empty"} notice=${surface.copyNotice || "missing"}`,
  );
  check(
    "call-target",
    surface.telHrefs.includes(expectedTelHref),
    surface.telHrefs.length ? surface.telHrefs.join(", ") : "missing",
  );
  check(
    "phone-not-rendered",
    !surface.bodyText.includes(expectedFormattedNumber),
    surface.bodyText.includes(expectedFormattedNumber)
      ? `visible text contains ${expectedFormattedNumber}`
      : "formatted number absent from visible text",
  );

  const configuredWhatsApp = normalizePhone(config.whatsAppNumber);
  const configSafe =
    config.whatsAppAdmissionValid !== false &&
    (!config.whatsAppEnabled ||
      (configuredWhatsApp === expectedGatewayNumber &&
        !rejectedWhatsAppNumbers.includes(configuredWhatsApp)));
  check(
    "whatsapp-sender-config",
    configSafe,
    `enabled=${String(config.whatsAppEnabled)} admission=${config.whatsAppAdmissionValid === false ? "invalid" : "valid"} configured=${configuredWhatsApp ?? "unset"}`,
  );

  if (config.whatsAppEnabled) {
    check(
      "whatsapp-public-admission",
      surface.whatsAppHrefs.length === 1 &&
        surface.whatsAppHrefs[0] === expectedWhatsAppHref,
      surface.whatsAppHrefs.length
        ? surface.whatsAppHrefs.join(", ")
        : "enabled but rendered CTA is missing",
    );
  } else {
    check(
      "whatsapp-fail-closed",
      surface.whatsAppHrefs.length === 0,
      surface.whatsAppHrefs.length
        ? `disabled but rendered ${surface.whatsAppHrefs.join(", ")}`
        : "disabled and no WhatsApp CTA rendered",
    );
  }

  check(
    "browser-console",
    surface.consoleErrors.length === 0,
    surface.consoleErrors.length
      ? surface.consoleErrors.join(" | ")
      : "no console errors",
  );

  return { ok: checks.every((entry) => entry.passed), checks };
}

async function inspectPublicSurface(origin) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    const response = await page.goto(`${origin}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response) throw new Error("homepage navigation returned no response");
    await page.waitForSelector('a[href^="tel:"]', {
      timeout: 20_000,
    });

    const collectHrefs = (selector) =>
      page
        .locator(selector)
        .evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute("href"))
            .filter((value) => typeof value === "string"),
        );

    const messageButton = page.getByRole("button", { name: "Message Eliza" });
    const messageButtonCount = await messageButton.count();
    let copiedPhone = "";
    let copyNotice = "";
    if (messageButtonCount === 1) {
      await messageButton.click();
      const status = page.getByRole("status");
      await status.waitFor({ state: "visible", timeout: 5_000 });
      copyNotice = await status.innerText();
      copiedPhone = await page.evaluate(() => navigator.clipboard.readText());
    }

    return {
      finalUrl: page.url(),
      server: response.headers().server ?? "",
      bodyText: await page.locator("body").innerText(),
      messageButtonCount,
      copiedPhone,
      copyNotice,
      telHrefs: await collectHrefs('a[href^="tel:"]'),
      whatsAppHrefs: await collectHrefs('a[href^="https://wa.me/"]'),
      consoleErrors,
    };
  } finally {
    await browser.close();
  }
}

function writeEvidence(evidencePath, evidence) {
  if (!evidencePath) return;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[homepage-public] evidence=${evidencePath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const variables = getRepoVariables();
  const whatsAppAdmission = resolveWhatsAppAdmission(
    variables.WHATSAPP_PUBLIC_ENABLED,
  );
  const whatsAppEnabled = whatsAppAdmission.enabled;
  const whatsAppNumber = variables.VITE_WHATSAPP_PHONE_NUMBER ?? "";
  const surface = await inspectPublicSurface(args.origin);
  const result = evaluatePublicSurface(surface, {
    origin: args.origin,
    whatsAppEnabled,
    whatsAppAdmissionValid: whatsAppAdmission.valid,
    whatsAppNumber,
  });

  for (const entry of result.checks) {
    console.log(
      `[homepage-public] ${entry.passed ? "PASS" : "BLOCKED"} ${entry.name}: ${entry.detail}`,
    );
  }

  const evidence = {
    ok: result.ok,
    checkedAt: new Date().toISOString(),
    origin: args.origin,
    expectedGatewayNumber,
    whatsAppEnabled,
    whatsAppAdmissionValid: whatsAppAdmission.valid,
    whatsAppNumber,
    checks: result.checks,
    surface: {
      finalUrl: surface.finalUrl,
      server: surface.server,
      messageButtonCount: surface.messageButtonCount,
      copiedPhone: surface.copiedPhone,
      copyNotice: surface.copyNotice,
      telHrefs: surface.telHrefs,
      whatsAppHrefs: surface.whatsAppHrefs,
      consoleErrors: surface.consoleErrors,
    },
  };
  writeEvidence(args.evidencePath, evidence);

  if (!result.ok) {
    console.error(
      "[homepage-public] next: deploy the current main Cloudflare Pages artifact; keep WHATSAPP_PUBLIC_ENABLED=false until Blooio exposes an active WhatsApp channel and a real handset inbound/reply round trip passes.",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(
      `[homepage-public] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
