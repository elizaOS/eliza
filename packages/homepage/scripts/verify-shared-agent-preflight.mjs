#!/usr/bin/env node

/**
 * Non-mutating browser preflight for the public shared-agent entry experience.
 *
 * This verifier intentionally does not click Text, Call, Telegram, or Sign in:
 * it proves the local homepage exposes the production handoffs without opening
 * a native app, authenticating, sending a message, or placing a call.
 */

import { chromium } from "playwright";

const DEFAULT_BASE_URL = "http://127.0.0.1:41780/";
const EXPECTED_TELEGRAM_URL = "https://t.me/ElizaIsNotABot";
const EXPECTED_SIGN_IN_URL = "https://cloud.eliza.app/login?intent=launch";

function localBaseUrl(input) {
  const url = new URL(input || DEFAULT_BASE_URL);
  const isLoopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "http:" || !isLoopback) {
    throw new Error(
      "SHARED_AGENT_BASE_URL must be an http://127.0.0.1 or http://localhost URL",
    );
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function visible(locator, label) {
  if ((await locator.count()) !== 1 || !(await locator.isVisible())) {
    throw new Error(`${label} is not uniquely visible`);
  }
}

const baseUrl = localBaseUrl(process.env.SHARED_AGENT_BASE_URL);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

try {
  const startedAt = performance.now();
  const response = await page.goto(baseUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (!response || response.status() >= 400) {
    throw new Error(`homepage returned ${response?.status() ?? "no response"}`);
  }

  const textButton = page.getByRole("button", {
    name: "Text Eliza",
    exact: true,
  });
  const callButton = page.getByRole("button", { name: "Call", exact: true });
  const telegramLink = page.getByRole("link", {
    name: "Message Eliza on Telegram",
    exact: true,
  });
  const signInLink = page.getByRole("link", { name: "Sign in", exact: true });

  await visible(textButton, "Text Eliza");
  await visible(callButton, "Call");
  await visible(telegramLink, "Message Eliza on Telegram");
  await visible(signInLink, "Sign in");

  const telegramUrl = await telegramLink.getAttribute("href");
  const signInUrl = await signInLink.getAttribute("href");
  if (telegramUrl !== EXPECTED_TELEGRAM_URL) {
    throw new Error(`Telegram handoff mismatch: ${telegramUrl ?? "missing"}`);
  }
  if (signInUrl !== EXPECTED_SIGN_IN_URL) {
    throw new Error(`Sign-in handoff mismatch: ${signInUrl ?? "missing"}`);
  }

  const illustrativeGroup = page
    .locator(".landing-phone-header .sr-only")
    .filter({ hasText: /^Illustrative .* group conversation / });
  if ((await illustrativeGroup.count()) !== 1) {
    throw new Error(
      "the group-chat demo is not explicitly labeled illustrative",
    );
  }
  if (
    (await page.getByRole("link", { name: /add eliza to .*group/i }).count()) >
    0
  ) {
    throw new Error("homepage exposes an unsupported live group-add promise");
  }

  // Give synchronous render errors a chance to surface. No handoff is clicked.
  await page.waitForTimeout(250);
  if (pageErrors.length || consoleErrors.length) {
    throw new Error(
      [
        ...pageErrors.map((error) => `page: ${error}`),
        ...consoleErrors.map((error) => `console: ${error}`),
      ].join("\n"),
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        baseUrl,
        httpStatus: response.status(),
        domReadyMs: Math.round(performance.now() - startedAt),
        visibleEntrypoints: ["Text Eliza", "Call", "Telegram", "Sign in"],
        telegramDestination: EXPECTED_TELEGRAM_URL,
        signInDestination: EXPECTED_SIGN_IN_URL,
        groupDemo: "explicitly illustrative; no live add-to-group CTA",
        providerActions: 0,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}
