// Shared harness for the dev-smoke live lane: boots against `bun run dev` (real
// API + vite renderer), completes a real local-runtime first-run using the
// selected live provider, and drives the real chat UI. Used by every
// bun-dev-*.spec.ts so the onboarding/chat plumbing lives in one place.

import { expect, type Locator, type Page } from "@playwright/test";
import { buildFirstRunRuntimeConfig } from "../../../app-core/src/first-run/first-run-config";
import {
  getFirstRunProviderForLiveProvider,
  selectLiveProvider,
} from "../../../app-core/test/helpers/live-provider";

export const API_PORT = Number(process.env.ELIZA_API_PORT || "31337");
export const API_BASE = `http://127.0.0.1:${API_PORT}`;
export const LIVE_PROVIDER = selectLiveProvider();
export const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

export type FirstRunStatus = { complete: boolean };
export type HealthStatus = { ready?: boolean };

export function browserFailureCollector(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/^\[RenderTelemetry\]/.test(text)) return;
    if (/504 \(Outdated Optimize Dep\)/i.test(text)) return;
    if (
      /^Failed to load resource: the server responded with a status of (401|404) /i.test(
        text,
      )
    ) {
      return;
    }
    failures.push(`console.error: ${text}`);
  });
  page.on("response", (response) => {
    if (response.status() === 504 && response.url().includes("/.vite/deps/")) {
      return;
    }
    if (response.status() < 500) return;
    failures.push(`${response.status()} ${response.url()}`);
  });
  return failures;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `${url} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

export async function waitForJson<T>(
  url: string,
  predicate: (value: T) => boolean,
  timeoutMs = 420_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let lastValue: T | null = null;

  while (Date.now() < deadline) {
    try {
      const value = await fetchJson<T>(url);
      lastValue = value;
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (lastValue) {
    throw new Error(
      `Timed out waiting for ${url}; last=${JSON.stringify(lastValue)}`,
    );
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

export async function submitFirstRun(
  overrides?: Partial<{ name: string; bio: string[]; systemPrompt: string }>,
): Promise<void> {
  if (!LIVE_PROVIDER) {
    throw new Error("No live provider selected");
  }

  const runtimeConfig = buildFirstRunRuntimeConfig({
    firstRunRuntimeTarget: "local",
    firstRunCloudApiKey: "",
    firstRunProvider: getFirstRunProviderForLiveProvider(LIVE_PROVIDER),
    firstRunApiKey: LIVE_PROVIDER.apiKey,
    firstRunVoiceProvider: "",
    firstRunVoiceApiKey: "",
    firstRunPrimaryModel: LIVE_PROVIDER.largeModel,
    firstRunOpenRouterModel: LIVE_PROVIDER.largeModel,
    firstRunRemoteConnected: false,
    firstRunRemoteApiBase: "",
    firstRunRemoteToken: "",
    firstRunSmallModel: LIVE_PROVIDER.smallModel,
    firstRunLargeModel: LIVE_PROVIDER.largeModel,
  });

  const response = await fetch(`${API_BASE}/api/first-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: overrides?.name ?? "Dev Smoke",
      bio: overrides?.bio ?? ["A CI smoke-test agent for bun run dev."],
      systemPrompt:
        overrides?.systemPrompt ??
        "You are a concise assistant used by CI smoke tests. Follow exact-output test instructions.",
      language: "en",
      presetId: "default",
      avatarIndex: 0,
      deploymentTarget: runtimeConfig.deploymentTarget,
      ...(runtimeConfig.linkedAccounts
        ? { linkedAccounts: runtimeConfig.linkedAccounts }
        : {}),
      ...(runtimeConfig.serviceRouting
        ? { serviceRouting: runtimeConfig.serviceRouting }
        : {}),
      ...(runtimeConfig.credentialInputs
        ? { credentialInputs: runtimeConfig.credentialInputs }
        : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `First-run submission failed with ${response.status}: ${await response.text()}`,
    );
  }
}

/** Boot the real runtime and complete onboarding once (idempotent across specs). */
export async function ensureOnboarded(): Promise<void> {
  await waitForJson<HealthStatus>(
    `${API_BASE}/api/health`,
    (health) => health.ready === true,
  );
  const status = await waitForJson<FirstRunStatus>(
    `${API_BASE}/api/first-run/status`,
    (value) => typeof value.complete === "boolean",
  );
  if (status.complete) return;
  await submitFirstRun();
  await waitForJson<FirstRunStatus>(
    `${API_BASE}/api/first-run/status`,
    (value) => value.complete === true,
  );
  await waitForJson<HealthStatus>(
    `${API_BASE}/api/health`,
    (health) => health.ready === true,
  );
}

function seedCompletedFirstRunStorageForOrigin(): void {
  localStorage.setItem("eliza:first-run-complete", "1");
  localStorage.setItem("eliza:setup:step", "activate");
  localStorage.setItem("eliza:ui-shell-mode", "native");
  localStorage.setItem("eliza:chat:voiceMuted", "true");
  // Pin the active server to THIS page's origin, not the raw agent port. The dev
  // UI server proxies /api -> the agent (see packages/app/vite.config.ts), so a
  // same-origin base reaches the agent through that proxy. Pinning the raw
  // loopback (127.0.0.1:31337) instead makes the browser hit the agent
  // cross-origin, which 401s /api/auth/status; with no token that strands
  // startup at `pairing-required` — the shell never paints and the chat composer
  // never appears (the dev-smoke red, #9452). location.origin is also how a real
  // `bun run dev` browser session reaches the agent, so this matches production.
  const base = location.origin;
  localStorage.setItem(
    "elizaos:active-server",
    JSON.stringify({
      id: `remote:${base}`,
      kind: "remote",
      label: "Dev smoke API",
      apiBase: base,
    }),
  );
}

export async function seedCompletedFirstRunStorage(page: Page): Promise<void> {
  await page.addInitScript(seedCompletedFirstRunStorageForOrigin);
  if (page.url() !== "about:blank") {
    await page.evaluate(seedCompletedFirstRunStorageForOrigin);
  }
}

export async function gotoChatComposer(page: Page): Promise<Locator> {
  let lastError: unknown;
  const composer = page.locator(CHAT_COMPOSER_SELECTOR).first();

  // Reuse the live chat route between warm-up and the asserted turn. Reloading
  // here can create a second conversation while startup is still resolving the
  // previous active conversation, causing the UI to switch threads mid-send.
  if (new URL(page.url()).pathname === "/chat") {
    try {
      await expect(composer).toBeVisible({ timeout: 5_000 });
      return composer;
    } catch (error) {
      lastError = error;
    }
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto("/chat");
    try {
      await expect(composer).toBeVisible({ timeout: 90_000 });
      return composer;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await page.waitForTimeout(1_000);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for chat composer");
}

/** Send a chat turn and return the composer locator. */
export async function sendChat(page: Page, prompt: string): Promise<void> {
  const composer = await gotoChatComposer(page);
  await composer.fill(prompt);
  await composer.press("Enter");
  const conversation = page.getByRole("region", {
    name: /conversation history/i,
  });
  await expect(conversation).toContainText(prompt, { timeout: 30_000 });
}

/**
 * Wait until the agent can produce a REAL model reply before the asserted turn.
 *
 * Model-provider plugins register in the deferred boot phase, so a chat fired
 * the instant /api/health flips ready can race that registration: with no
 * provider yet, the router surfaces a setup-hint/failure bubble instead of a
 * real reply. We resend a deterministic probe until the agent echoes the marker
 * — proving the provider is registered and routing works — so the real assertion
 * that follows is not flaky. (This race was previously masked by asserting the
 * marker against the whole conversation log, which always matched the prompt.)
 */
export async function warmUpModel(page: Page): Promise<void> {
  const assistant = page.locator(
    '[data-testid="thread-line"][data-role="assistant"]',
  );
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const marker = `READY_${attempt}`;
    const composer = await gotoChatComposer(page);
    await composer.fill(`Reply with exactly ${marker} and nothing else.`);
    await composer.press("Enter");
    try {
      await expect(assistant.filter({ hasText: marker }).first()).toBeVisible({
        timeout: 30_000,
      });
      return;
    } catch {
      // Provider not registered yet (or model still loading) — resend.
    }
  }
  throw new Error(
    "agent never produced a real model reply — provider did not register",
  );
}
