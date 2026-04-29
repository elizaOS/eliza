import { setTimeout as sleep } from "node:timers/promises";
import {
  chromium,
  type Browser as PlaywrightBrowser,
  type LaunchOptions as PlaywrightLaunchOptions,
} from "playwright-core";
import puppeteer, {
  type Browser as PuppeteerBrowser,
  type LaunchOptions as PuppeteerLaunchOptions,
} from "puppeteer-core";

type RetryOptions = {
  attempts?: number;
  delayMs?: number;
};

function buildRetryError(
  label: string,
  attempts: number,
  error: unknown,
): Error {
  const cause =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new Error(
    `${label} failed after ${attempts} attempts. Last error: ${cause}`,
  );
}

export async function launchPuppeteerBrowserWithRetry(
  options: PuppeteerLaunchOptions,
  retryOptions: RetryOptions = {},
): Promise<PuppeteerBrowser> {
  const attempts = retryOptions.attempts ?? 3;
  const delayMs = retryOptions.delayMs ?? 1_500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await puppeteer.launch(options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      await sleep(delayMs * attempt);
    }
  }

  throw buildRetryError("Puppeteer browser launch", attempts, lastError);
}

export async function launchPlaywrightBrowserWithRetry(
  options: PlaywrightLaunchOptions,
  retryOptions: RetryOptions = {},
): Promise<PlaywrightBrowser> {
  const attempts = retryOptions.attempts ?? 3;
  const delayMs = retryOptions.delayMs ?? 1_500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      await sleep(delayMs * attempt);
    }
  }

  throw buildRetryError("Playwright browser launch", attempts, lastError);
}

export async function closePuppeteerBrowser(
  browser: PuppeteerBrowser | null | undefined,
  retryOptions: RetryOptions = {},
): Promise<void> {
  if (!browser) {
    return;
  }

  const delayMs = retryOptions.delayMs ?? 1_500;
  const process = browser.process?.();
  await browser.close();
  if (process && process.exitCode == null) {
    await new Promise<void>((resolve) => process.once("exit", () => resolve()));
  }
  await sleep(delayMs);
}

export async function closePlaywrightBrowser(
  browser: PlaywrightBrowser | null | undefined,
  retryOptions: RetryOptions = {},
): Promise<void> {
  if (!browser) {
    return;
  }

  const delayMs = retryOptions.delayMs ?? 1_500;
  await browser.close();
  await sleep(delayMs);
}
