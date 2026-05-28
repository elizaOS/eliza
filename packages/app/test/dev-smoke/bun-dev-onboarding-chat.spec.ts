import { expect, type Page, test } from "@playwright/test";
import { buildFirstRunRuntimeConfig } from "../../../app-core/src/first-run/first-run-config";
import { selectLiveProvider } from "../../../app-core/test/helpers/live-provider";

const API_PORT = Number(process.env.ELIZA_API_PORT || "31337");
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const LIVE_PROVIDER = selectLiveProvider();
const RESPONSE_MARKER = "BUN_DEV_SMOKE_OK";

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
    onboardingServerTarget: "local",
    onboardingCloudApiKey: "",
    onboardingProvider: LIVE_PROVIDER.name,
    onboardingApiKey: LIVE_PROVIDER.apiKey,
    onboardingVoiceProvider: "",
    onboardingVoiceApiKey: "",
    onboardingPrimaryModel: LIVE_PROVIDER.largeModel,
    onboardingOpenRouterModel: LIVE_PROVIDER.largeModel,
    onboardingRemoteConnected: false,
    onboardingRemoteApiBase: "",
    onboardingRemoteToken: "",
    onboardingSmallModel: LIVE_PROVIDER.smallModel,
    onboardingLargeModel: LIVE_PROVIDER.largeModel,
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

async function seedCompletedFirstRunStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("eliza:first-run-complete", "1");
    localStorage.setItem("eliza:setup:step", "activate");
    localStorage.setItem("eliza:ui-shell-mode", "native");
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:embedded",
        kind: "local",
        label: "This device",
      }),
    );
  });
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

    await seedCompletedFirstRunStorage(page);
    await page.goto("/chat");
    await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
      timeout: 60_000,
    });

    const prompt = `For a CI smoke test, reply with exactly ${RESPONSE_MARKER} and no other words.`;
    await page.getByTestId("chat-composer-textarea").fill(prompt);
    await expect(page.getByTestId("chat-composer-action")).toBeEnabled();
    await page.getByTestId("chat-composer-action").click();

    await expect(
      page
        .locator('[data-testid="chat-message"][data-role="user"]')
        .filter({ hasText: prompt })
        .last(),
    ).toBeVisible({ timeout: 30_000 });

    await expect(
      page
        .locator('[data-testid="chat-message"][data-role="assistant"]')
        .filter({ hasText: new RegExp(RESPONSE_MARKER, "i") })
        .last(),
    ).toBeVisible({ timeout: 120_000 });

    expect(failures, "browser/runtime failures").toEqual([]);
  });
});
