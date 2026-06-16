import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildFirstRunRuntimeConfig } from "../../../app-core/src/first-run/first-run-config";
import {
  getFirstRunProviderForLiveProvider,
  selectLiveProvider,
} from "../../../app-core/test/helpers/live-provider";

const API_PORT = Number(process.env.ELIZA_API_PORT || "31337");
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const LIVE_PROVIDER = selectLiveProvider();
const RESPONSE_MARKER = "BUN_DEV_SMOKE_OK";
const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

type FirstRunStatus = {
  complete: boolean;
};

type HealthStatus = {
  ready?: boolean;
};

function browserFailureCollector(page: Page): string[] {
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
    if (
      response.status() === 504 &&
      response.url().includes("/.vite/deps/")
    ) {
      return;
    }
    if (response.status() < 500) return;
    failures.push(`${response.status()} ${response.url()}`);
  });
  return failures;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `${url} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function waitForJson<T>(
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
      if (predicate(value)) {
        return value;
      }
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

async function submitFirstRun(): Promise<void> {
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
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Dev Smoke",
      bio: ["A CI smoke-test agent for bun run dev."],
      systemPrompt:
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

function seedCompletedFirstRunStorageForOrigin(apiBase: string): void {
  localStorage.setItem("eliza:first-run-complete", "1");
  localStorage.setItem("eliza:setup:step", "activate");
  localStorage.setItem("eliza:ui-shell-mode", "native");
  localStorage.setItem("eliza:chat:voiceMuted", "true");
  localStorage.setItem(
    "elizaos:active-server",
    JSON.stringify({
      id: `remote:${apiBase}`,
      kind: "remote",
      label: "Dev smoke API",
      apiBase,
    }),
  );
}

async function seedCompletedFirstRunStorage(page: Page): Promise<void> {
  await page.addInitScript(seedCompletedFirstRunStorageForOrigin, API_BASE);
  if (page.url() !== "about:blank") {
    await page.evaluate(seedCompletedFirstRunStorageForOrigin, API_BASE);
  }
}

async function gotoChatComposer(page: Page): Promise<Locator> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto("/chat");
    const composer = page.locator(CHAT_COMPOSER_SELECTOR).first();
    try {
      await expect(composer).toBeVisible({ timeout: 90_000 });
      return composer;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await page.waitForTimeout(1_000);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for chat composer");
}

test.describe("bun run dev onboarding chat smoke", () => {
  test.skip(!LIVE_PROVIDER, "set a supported live provider key for dev smoke");

  test("starts dev, completes onboarding, and sends a chat message", async ({
    page,
  }) => {
    const failures = browserFailureCollector(page);

    await waitForJson<HealthStatus>(
      `${API_BASE}/api/health`,
      (health) => health.ready === true,
    );

    const initialStatus = await waitForJson<FirstRunStatus>(
      `${API_BASE}/api/first-run/status`,
      (status) => typeof status.complete === "boolean",
    );
    expect(initialStatus.complete).toBe(false);

    await submitFirstRun();
    await waitForJson<FirstRunStatus>(
      `${API_BASE}/api/first-run/status`,
      (status) => status.complete === true,
    );
    await waitForJson<HealthStatus>(
      `${API_BASE}/api/health`,
      (health) => health.ready === true,
    );

    await seedCompletedFirstRunStorage(page);
    await page.goto("/");
    await seedCompletedFirstRunStorage(page);
    const composer = await gotoChatComposer(page);

    const prompt = `For a CI smoke test, reply with exactly ${RESPONSE_MARKER} and no other words.`;
    await composer.fill(prompt);
    await composer.press("Enter");

    const conversation = page.getByRole("log", {
      name: /conversation history/i,
    });
    await expect(conversation).toContainText(prompt, { timeout: 30_000 });

    // Assert the AGENT's reply contains the marker — NOT the whole conversation
    // log, which also contains the user's own prompt ("reply with exactly
    // <MARKER>"). Matching the log would pass even when the agent never responds
    // (e.g. no model provider registered), which is a false green. The reply must
    // come from a `data-role="assistant"` thread line produced by a real model.
    const assistantReply = page
      .locator('[data-testid="thread-line"][data-role="assistant"]')
      .filter({ hasText: RESPONSE_MARKER });
    await expect(assistantReply.first()).toBeVisible({ timeout: 180_000 });

    expect(failures, "browser/runtime failures").toEqual([]);
  });
});
