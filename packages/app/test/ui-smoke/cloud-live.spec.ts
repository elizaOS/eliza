/**
 * Exercises real login, Personal Eliza identity resolution, and chat through
 * Eliza Cloud, without mocking cloud endpoints. The opt-in workflow must supply
 * both live-stack flags and ELIZAOS_CLOUD_API_KEY; this test spends real cloud
 * credits and must never run in a keyless PR lane.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveDirectCloudAuthApiBase } from "@elizaos/ui/api/direct-cloud-endpoints";
import { isPersonalSharedElizaId } from "@elizaos/ui/utils/cloud-agent-base";
import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import {
  resolveCloudLiveBrowserAuthSeed,
  seedCloudLiveBrowserAuth,
} from "../cloud-live-browser-auth";
import {
  assertCloudLiveNamedWarmingMode,
  assertCloudLiveNamedWarmingProof,
  type CloudLiveBindingReuse,
  type CloudLiveContinuityEvidenceInput,
  type CloudLiveHistoryObservation,
  type CloudLiveRuntimeBinding,
  compareCloudLiveRuntimeBindings,
  createCloudLiveContinuityEvidence,
  createCloudLiveNetworkAudit,
  installCloudLiveAnchoredRetryChipObserver,
  writeCloudLiveContinuityEvidence,
} from "../cloud-live-continuity-contract";
import { resolveCloudLiveOriginContract } from "../cloud-live-origin";
import {
  assertOnboardingLivenessWithTiming,
  findAnchoredLiveTurn,
  isLiveReply,
  readLivenessThreadLines,
} from "../liveness-contract";
import { writeStagingCloudChatLatencyEvidence } from "../staging-cloud-chat-latency-evidence";
import { openAppPath } from "./helpers";

const CLOUD_LIVE_ENABLED =
  process.env.ELIZA_UI_SMOKE_CLOUD_LIVE === "1" &&
  process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const HAS_CLOUD_KEY = Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim());
const DEPLOYED_RENDERER_ENABLED =
  process.env.ELIZA_UI_SMOKE_DEPLOYED_RENDERER === "1";
const DEPLOYED_RENDERER_ALIAS = "https://develop.eliza-app.pages.dev";
const DEPLOYED_RENDERER_MANIFEST_SCHEMA = "elizaos.renderer.build/v1";
const DEPLOYED_BROWSER_SMOKE_SCHEMA = "elizaos.cloud.deployed-browser-smoke/v1";
const REQUIRE_NAMED_WARMING =
  process.env.ELIZA_UI_SMOKE_REQUIRE_NAMED_WARMING === "1";

const PERSONAL_IDENTITY_ATTEMPT_TIMEOUT_MS = 180_000;
const PERSONAL_IDENTITY_ATTEMPTS = 2;

// This lane deliberately places a real Cloud bearer in browser storage.
// Playwright traces record init-script arguments and request headers, while
// screenshots/video can retain private model content. This credentialed lane
// uploads neither; its durable evidence is the closed-schema receipt/metric.
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  serviceWorkers: "block",
});

// Click an optional onboarding affordance. Absence is a legitimate product
// state: the runtime chooser and the OAuth authorize block only render under
// some first-run configurations, so a visibility timeout is reported as an
// explicit "not offered". A click that fails on a control that IS visible is a
// real defect and must fail the lane rather than be swallowed.
async function clickIfVisible(
  locator: Locator,
  timeout = 10_000,
): Promise<boolean> {
  const target = locator.first();
  const offered = await target.waitFor({ state: "visible", timeout }).then(
    () => true,
    // error-policy:J4 a timeout is the one expected failure — the optional
    // affordance never appeared — and becomes a distinct absent state. Anything
    // else is rethrown: a strict-mode violation (two elements matched the
    // locator) would otherwise be reported as "not offered", quietly turning a
    // broken selector into a passing skip.
    (error: unknown) => {
      if (error instanceof Error && error.name === "TimeoutError") return false;
      throw error;
    },
  );
  if (!offered) return false;
  await target.click();
  return true;
}

// Drive the cloud entry point of first-run: the transcript's Eliza Cloud option,
// then the SensitiveRequestBlock "Connect Eliza Cloud" OAuth authorize
// affordance if shown.
async function chooseCloudRuntime(page: Page): Promise<void> {
  await clickIfVisible(
    page.getByTestId("choice-__first_run__:runtime:cloud"),
    30_000,
  );
  await clickIfVisible(
    page.getByTestId("sensitive-request-oauth-start"),
    5_000,
  );
}

async function seedProtectedCloudBlankStart(page: Page): Promise<void> {
  // A local renderer is already controlled by the checked-out process, so its
  // established init-script handoff remains safe. A deployed renderer must be
  // reached and origin-verified before the bearer is ever handed to the page.
  if (!DEPLOYED_RENDERER_ENABLED) {
    expect(
      await seedCloudLiveBrowserAuth({
        async addInitScript(script, seed) {
          await page.addInitScript(script, seed);
        },
      }),
      "Cloud-live mode must hand its validated workflow bearer to the browser",
    ).toBe(true);
  }
  await page.addInitScript(() => {
    // Do not use the general smoke seed: its local active-server fixture would
    // invalidate a fresh-context continuity claim. These non-secret empty values
    // are safe before navigation; deployed mode seeds the bearer only after the
    // exact top-level Pages origin and renderer identity are verified.
    if (localStorage.getItem("eliza:first-run-complete") === null) {
      localStorage.setItem("eliza:first-run-complete", "");
    }
    if (localStorage.getItem("elizaos:active-server") === null) {
      localStorage.setItem("elizaos:active-server", "");
    }
  });
}

async function seedVerifiedDeployedCloudBrowserAuth(page: Page): Promise<void> {
  const seed = resolveCloudLiveBrowserAuthSeed(process.env);
  expect(
    seed,
    "deployed Cloud-live mode requires a validated workflow bearer",
  ).not.toBeNull();
  if (!seed) throw new Error("missing deployed Cloud-live browser auth seed");

  expect(
    new URL(page.url()).origin,
    "the bearer must never be handed to a document outside the Pages alias",
  ).toBe(DEPLOYED_RENDERER_ALIAS);
  await page.evaluate(
    ({ expectedOrigin, storageKey, token }) => {
      if (window.top !== window || window.location.origin !== expectedOrigin) {
        throw new Error(
          "refusing to seed deployed Cloud auth outside the verified top-level origin",
        );
      }
      localStorage.setItem(storageKey, token);
    },
    { expectedOrigin: DEPLOYED_RENDERER_ALIAS, ...seed },
  );
}

interface DeployedRendererIdentity {
  buildId: string;
  commit: string;
  origin: string;
}

interface ProtectedCloudBlankStart {
  deployedRenderer: DeployedRendererIdentity | null;
  rendererApiOrigin: string;
}

async function requireDeployedRendererIdentity(
  page: Page,
  baseURL: string | undefined,
): Promise<DeployedRendererIdentity | null> {
  if (!DEPLOYED_RENDERER_ENABLED) return null;
  const sourceSha =
    process.env.ELIZA_UI_SMOKE_DEPLOYED_SOURCE_SHA?.trim() ?? "";
  expect(
    sourceSha,
    "deployed renderer mode requires an exact source SHA",
  ).toMatch(/^[0-9a-f]{40}$/);
  expect(
    new URL(baseURL ?? "https://missing.invalid").origin,
    "deployed Playwright must be hard-pinned to the canonical develop Pages alias",
  ).toBe(DEPLOYED_RENDERER_ALIAS);
  expect(
    new URL(page.url()).origin,
    "the browser document must not redirect away from the deployment alias",
  ).toBe(DEPLOYED_RENDERER_ALIAS);

  const observed = await page.evaluate(async (expectedOrigin) => {
    const response = await fetch(
      `/eliza-renderer-build.json?deployed-browser-proof=${Date.now()}`,
      { cache: "no-store", headers: { "cache-control": "no-cache" } },
    );
    const responseUrl = new URL(response.url);
    if (
      !response.ok ||
      responseUrl.origin !== expectedOrigin ||
      responseUrl.pathname !== "/eliza-renderer-build.json"
    ) {
      throw new Error(
        "renderer manifest did not come from the deployment alias",
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }, DEPLOYED_RENDERER_ALIAS);
  expect(Object.keys(observed).sort()).toEqual(
    [
      "assetCount",
      "buildId",
      "builtAt",
      "capacitorTarget",
      "commit",
      "indexHtmlSha256",
      "iosApnsEnabled",
      "playwrightTestAuth",
      "runtimeMode",
      "schema",
      "variant",
    ].sort(),
  );
  expect(observed.schema).toBe(DEPLOYED_RENDERER_MANIFEST_SCHEMA);
  expect(observed.commit).toBe(sourceSha);
  expect(observed.buildId).toMatch(/^[0-9a-f]{64}$/);
  expect(observed.indexHtmlSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(observed.assetCount).toEqual(expect.any(Number));
  expect(observed.assetCount).toBeGreaterThan(0);
  expect(observed.playwrightTestAuth).toBe(false);
  return {
    buildId: observed.buildId as string,
    commit: sourceSha,
    origin: DEPLOYED_RENDERER_ALIAS,
  };
}

async function requireRendererCloudApiOrigin(
  page: Page,
  expectedApiOrigin: string,
): Promise<string> {
  // The renderer carries its own Cloud base, resolved at BUILD time from
  // VITE_ELIZA_CLOUD_BASE and otherwise defaulted. In deployed mode this check
  // runs on the first public load, before the staging bearer reaches the page.
  const readRendererCloudBase = () =>
    page.evaluate(() => {
      const config = (
        window as unknown as {
          __ELIZAOS_APP_BOOT_CONFIG__?: { cloudApiBase?: string };
        }
      ).__ELIZAOS_APP_BOOT_CONFIG__;
      return config?.cloudApiBase?.trim() ?? "";
    });
  await expect
    .poll(readRendererCloudBase, {
      message: "renderer boot config must expose its Cloud base",
      timeout: 30_000,
    })
    .not.toBe("");
  const rendererCloudBase = await readRendererCloudBase();
  const rendererApiOrigin = (() => {
    if (!rendererCloudBase) return "";
    try {
      return new URL(resolveDirectCloudAuthApiBase(rendererCloudBase)).origin;
    } catch {
      // error-policy:J3 a malformed boot value is reported as an explicit
      // mismatch carrying the offending string, never as a raw TypeError.
      return `<unparseable: ${rendererCloudBase}>`;
    }
  })();
  expect(
    rendererApiOrigin,
    `renderer bundle resolves ${rendererCloudBase || "<unset>"} -> ${rendererApiOrigin || "<empty>"}; the lane pinned ${expectedApiOrigin}`,
  ).toBe(expectedApiOrigin);
  return rendererApiOrigin;
}

async function openProtectedCloudBlankStart(
  page: Page,
  baseURL: string | undefined,
  expectedApiOrigin: string,
): Promise<ProtectedCloudBlankStart> {
  await seedProtectedCloudBlankStart(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const publicIdentity = await requireDeployedRendererIdentity(page, baseURL);
  const publicApiOrigin = await requireRendererCloudApiOrigin(
    page,
    expectedApiOrigin,
  );
  if (!DEPLOYED_RENDERER_ENABLED) {
    return {
      deployedRenderer: publicIdentity,
      rendererApiOrigin: publicApiOrigin,
    };
  }

  // The first load is deliberately public. Only after the document origin,
  // exact renderer manifest, and build-time Cloud API origin close do we expose
  // the bearer to that top-level origin, then reload so application boot
  // observes the authenticated store.
  expect(publicIdentity).not.toBeNull();
  await seedVerifiedDeployedCloudBrowserAuth(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  const authenticatedIdentity = await requireDeployedRendererIdentity(
    page,
    baseURL,
  );
  expect(authenticatedIdentity).toEqual(publicIdentity);
  const authenticatedApiOrigin = await requireRendererCloudApiOrigin(
    page,
    expectedApiOrigin,
  );
  expect(authenticatedApiOrigin).toBe(publicApiOrigin);
  return {
    deployedRenderer: authenticatedIdentity,
    rendererApiOrigin: authenticatedApiOrigin,
  };
}

async function writeDeployedBrowserSmokeEvidence(
  path: string,
  renderer: DeployedRendererIdentity,
  cloudApiOrigin: string,
): Promise<void> {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        schema: DEPLOYED_BROWSER_SMOKE_SCHEMA,
        sourceSha: renderer.commit,
        rendererOrigin: renderer.origin,
        rendererManifestCommit: renderer.commit,
        rendererBuildId: renderer.buildId,
        cloudApiOrigin,
        cloudEnvironment: "staging",
        outcome: "success",
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

async function readActiveBinding(
  page: Page,
): Promise<CloudLiveRuntimeBinding | null> {
  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem("elizaos:active-server");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      kind: parsed.kind,
      id: parsed.id,
      cloudRuntimeAgentId: parsed.cloudRuntimeAgentId,
      runtime: parsed.cloudRuntime,
      apiBase: parsed.apiBase,
    };
  });
  if (
    persisted?.kind !== "cloud" ||
    typeof persisted.id !== "string" ||
    !persisted.id.startsWith("cloud:") ||
    !isPersonalSharedElizaId(persisted.id.slice("cloud:".length)) ||
    typeof persisted.cloudRuntimeAgentId !== "string" ||
    !persisted.cloudRuntimeAgentId ||
    (persisted.runtime !== "shared" && persisted.runtime !== "dedicated") ||
    typeof persisted.apiBase !== "string" ||
    !persisted.apiBase
  ) {
    return null;
  }
  // Never return accessToken or the rest of the persisted record to the test
  // process; only the private inputs needed for in-memory comparison cross.
  return {
    personalIdentity: persisted.id,
    runtimeBinding: persisted.cloudRuntimeAgentId,
    runtime: persisted.runtime,
    apiBase: persisted.apiBase,
  };
}

async function requireActiveBinding(
  page: Page,
): Promise<CloudLiveRuntimeBinding> {
  const binding = await readActiveBinding(page);
  if (!binding) {
    throw new Error(
      "Personal Eliza did not persist the required logical/runtime/API binding fields",
    );
  }
  return binding;
}

function installNetworkAudit(context: BrowserContext) {
  const audit = createCloudLiveNetworkAudit();
  context.on("request", (request) => {
    audit.observeRequest(request.method(), request.url(), request.postData());
  });
  context.on("response", (response) => {
    const responseHeaders = response.headers();
    const contentType = responseHeaders["content-type"];
    const contentEncoding = responseHeaders["content-encoding"]
      ?.trim()
      .toLowerCase();
    audit.observeResponse(
      response.request().method(),
      response.url(),
      response.status(),
      {
        contentType,
        async read(maxBytes) {
          if (contentEncoding && contentEncoding !== "identity") return null;
          if (await response.finished()) return null;
          const { responseBodySize } = await response.request().sizes();
          if (
            !Number.isSafeInteger(responseBodySize) ||
            responseBodySize <= 0 ||
            responseBodySize > maxBytes
          )
            return null;
          const bytes = await response.body();
          return bytes.byteLength <= maxBytes ? bytes : null;
        },
      },
    );
  });
  return audit;
}

async function armAnchoredRetryChipObserver(
  page: Page,
  turnAnchorToken: string,
): Promise<{ stop(): Promise<boolean> }> {
  const observation = await page.evaluateHandle(
    installCloudLiveAnchoredRetryChipObserver,
    turnAnchorToken,
  );

  return {
    async stop() {
      try {
        return await observation.evaluate((state) => state.stop());
      } finally {
        await observation.dispose();
      }
    },
  };
}

async function proveAnchoredTurnHistory(
  page: Page,
  audit: ReturnType<typeof createCloudLiveNetworkAudit>,
  priorCount: number,
  turnAnchorToken: string,
): Promise<CloudLiveHistoryObservation> {
  await expect
    .poll(
      async () =>
        (await audit.snapshot()).successfulHistoryGetCount > priorCount,
      { timeout: 120_000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        const anchored = findAnchoredLiveTurn(
          await readLivenessThreadLines(page),
          { anchorToken: turnAnchorToken },
        );
        return Boolean(anchored && isLiveReply(anchored.reply));
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  return {
    historyGetSucceeded: true,
    challengeUserLinePresent: true,
    challengeAssistantLinePresent: true,
  };
}

async function resolvePersonalIdentity(
  page: Page,
): Promise<CloudLiveRuntimeBinding> {
  await expect(page.getByTestId("chat-overlay")).toBeVisible({
    timeout: 60_000,
  });
  await chooseCloudRuntime(page);
  for (let attempt = 1; attempt <= PERSONAL_IDENTITY_ATTEMPTS; attempt += 1) {
    let binding: CloudLiveRuntimeBinding | null = null;
    await expect
      .poll(
        async () => {
          binding = await readActiveBinding(page);
          return (
            Boolean(binding) ||
            (await page
              .getByTestId("choice-__first_run__:error:retry")
              .isVisible())
          );
        },
        { timeout: PERSONAL_IDENTITY_ATTEMPT_TIMEOUT_MS },
      )
      .toBe(true);
    if (binding) {
      await clickIfVisible(
        page.getByTestId("choice-__first_run__:tutorial:skip"),
        15_000,
      );
      return binding;
    }
    if (attempt === PERSONAL_IDENTITY_ATTEMPTS) {
      throw new Error("Personal Eliza identity resolution exhausted its retry");
    }
    await page.getByTestId("choice-__first_run__:error:retry").click();
  }
  throw new Error("Personal Eliza identity resolution remained pending");
}

test.describe("real cloud login + personal identity + chat", () => {
  test.setTimeout(900_000);
  test.skip(
    !CLOUD_LIVE_ENABLED && !REQUIRE_NAMED_WARMING,
    "set ELIZA_UI_SMOKE_CLOUD_LIVE=1 and ELIZA_UI_SMOKE_LIVE_STACK=1 to run against real Eliza Cloud",
  );
  test.skip(
    !HAS_CLOUD_KEY && !REQUIRE_NAMED_WARMING,
    "set ELIZAOS_CLOUD_API_KEY to authenticate to real Eliza Cloud",
  );

  test("resolves Personal Eliza, chats once, and preserves server history", async ({
    baseURL,
    browser,
    context,
    page,
  }) => {
    // #18076: prove which Cloud deployment this lane targets BEFORE any
    // auth/identity/chat traffic. When the workflow pins an expected
    // environment (staging/production), a defaulted or mismatched origin is a
    // hard failure — never a silent fall-through to production.
    const originContract = resolveCloudLiveOriginContract(process.env);
    test.info().annotations.push(
      { type: "cloud-api-origin", description: originContract.origin },
      { type: "cloud-environment", description: originContract.environment },
      {
        type: "renderer-source",
        description: DEPLOYED_RENDERER_ENABLED
          ? "Cloudflare Pages deployment alias"
          : "locally built renderer bundle (not a deployed artifact)",
      },
    );
    if (DEPLOYED_RENDERER_ENABLED) {
      test.info().annotations.push({
        type: "cloudflare-pages-alias",
        description: DEPLOYED_RENDERER_ALIAS,
      });
    }
    expect(
      originContract.ok,
      originContract.reason ??
        `resolved Cloud API origin: ${originContract.origin}`,
    ).toBe(true);
    // Reject an impossible opt-in before a staging bearer can reach any page.
    // The authoritative renderer attestation still runs after protected boot.
    assertCloudLiveNamedWarmingMode({
      required: REQUIRE_NAMED_WARMING,
      deployedRenderer: DEPLOYED_RENDERER_ENABLED,
      cloudEnvironment: originContract.environment,
    });
    test.info().annotations.push({
      type: "named-warming-proof-required",
      description: String(REQUIRE_NAMED_WARMING),
    });

    const stagingLatencyEvidencePath =
      process.env.ELIZA_UI_SMOKE_STAGING_CHAT_LATENCY_EVIDENCE_PATH?.trim() ??
      "";
    const stagingContinuityEvidencePath =
      process.env.ELIZA_UI_SMOKE_STAGING_CONTINUITY_EVIDENCE_PATH?.trim() ?? "";
    const deployedBrowserEvidencePath =
      process.env.ELIZA_UI_SMOKE_DEPLOYED_BROWSER_EVIDENCE_PATH?.trim() ?? "";
    if (originContract.environment === "staging") {
      expect(
        stagingLatencyEvidencePath,
        "the staging lane must persist its privacy-safe chat latency artifact",
      ).toBeTruthy();
      expect(
        stagingContinuityEvidencePath,
        "the staging lane must persist its privacy-safe continuity artifact",
      ).toBeTruthy();
      if (DEPLOYED_RENDERER_ENABLED) {
        expect(
          deployedBrowserEvidencePath,
          "deployed mode must persist its closed remote-browser proof",
        ).toBeTruthy();
      }
    }

    const primaryAudit = installNetworkAudit(context);
    const { deployedRenderer, rendererApiOrigin } =
      await openProtectedCloudBlankStart(page, baseURL, originContract.origin);
    // Dormant #18045 proof must never turn a local renderer or production run
    // into evidence merely because its opt-in flag was set. This uses the
    // verified public + authenticated renderer attestation above, not env shape.
    assertCloudLiveNamedWarmingMode({
      required: REQUIRE_NAMED_WARMING,
      deployedRenderer: deployedRenderer !== null,
      cloudEnvironment: originContract.environment,
    });
    test.info().annotations.push({
      type: "renderer-cloud-origin",
      description: rendererApiOrigin,
    });

    // The current Cloud join flow resolves the account-derived Personal Eliza
    // identity through the read-only Personal endpoint. It persists the
    // account-owned binding without creating dedicated compute.
    const referenceBinding = await resolvePersonalIdentity(page);
    const identityAudit = await primaryAudit.snapshot();
    expect(
      identityAudit.successfulPersonalIdentityGetCount,
      "Personal Eliza resolution must include a successful canonical identity GET",
    ).toBeGreaterThan(0);

    // Real chat turn against the resolved Personal Eliza agent — the liveness
    // contract (#14359) proves a real model answered (non-empty, no stub marker).
    // The random token anchors the exact user row; transcript order pairs its
    // following assistant row without treating verbatim code echo as a model
    // liveness requirement.
    await openAppPath(page, "/chat");
    const turnAnchorToken = randomBytes(8).toString("hex");
    const turnPrompt = `In one short sentence, say hello. Unique turn marker: ${turnAnchorToken}`;
    const auditBeforeLiveness = await primaryAudit.snapshot();
    const domBeforeLiveness = await page.evaluate(() => ({
      userRowCount: document.querySelectorAll(
        '[data-testid="thread-line"][data-role="user"]',
      ).length,
      assistantRowCount: document.querySelectorAll(
        '[data-testid="thread-line"][data-role="assistant"]',
      ).length,
    }));
    // Arm before the liveness helper performs its single send click. A final
    // DOM snapshot cannot prove that a Retry chip never flashed and vanished.
    const retryObserverAttempt = await armAnchoredRetryChipObserver(
      page,
      turnAnchorToken,
    ).then(
      (observer) => ({ ok: true as const, observer }),
      () => ({ ok: false as const }),
    );
    if (!retryObserverAttempt.ok && REQUIRE_NAMED_WARMING) {
      throw new Error(
        "Cloud live Retry-chip observer failed to arm; named warming proof is unavailable",
      );
    }
    const livenessAttempt = await assertOnboardingLivenessWithTiming(page, {
      label: "cloud-live",
      prompt: turnPrompt,
      turnAnchorToken,
    }).then(
      (liveness) => ({ ok: true as const, liveness }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const retryObservation = retryObserverAttempt.ok
      ? await retryObserverAttempt.observer.stop().then(
          (retryChipEverObserved) => ({
            ok: true as const,
            retryChipEverObserved,
          }),
          () => ({ ok: false as const }),
        )
      : { ok: false as const };
    test.info().annotations.push(
      {
        type: "anchored-retry-chip-observation-available",
        description: String(retryObservation.ok),
      },
      {
        type: "anchored-retry-chip-ever-observed",
        description: retryObservation.ok
          ? String(retryObservation.retryChipEverObserved)
          : "unavailable",
      },
    );

    if (!livenessAttempt.ok) {
      const { error } = livenessAttempt;
      // error-policy:J3 reduce the original assertion and live browser state
      // to an allowlisted name plus counts/booleans only. Never emit the draft,
      // challenge, response text, request URL, or any account/runtime ID.
      const auditAfterLiveness = await primaryAudit.snapshot();
      const [domSnapshotResult] = await Promise.allSettled([
        page.evaluate((before) => {
          const userRows = Array.from(
            document.querySelectorAll(
              '[data-testid="thread-line"][data-role="user"]',
            ),
          );
          const assistantRows = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-testid="thread-line"][data-role="assistant"]',
            ),
          );
          const freshAssistantRows = assistantRows.slice(
            before.assistantRowCount,
          );
          const composer = document.querySelector<
            HTMLTextAreaElement | HTMLInputElement
          >('[data-testid="chat-composer-textarea"]');
          return {
            draftCleared: composer ? composer.value.trim().length === 0 : null,
            newUserRowCount: Math.max(0, userRows.length - before.userRowCount),
            newAssistantRowCount: Math.max(
              0,
              assistantRows.length - before.assistantRowCount,
            ),
            failureRowPresent: freshAssistantRows.some((row) =>
              Boolean(row.dataset.failure?.trim()),
            ),
            retryRowPresent: freshAssistantRows.some((row) =>
              Boolean(row.querySelector('[data-testid="thread-line-retry"]')),
            ),
            interruptedRowPresent: freshAssistantRows.some(
              (row) => row.dataset.interrupted === "true",
            ),
            widgetOnlyReplyRowPresent: freshAssistantRows.some((row) => {
              const body = row.querySelector<HTMLElement>(
                '[data-testid="overlay-assistant-turn-body"]',
              );
              return (
                body?.dataset.phase === "reply" &&
                body.dataset.hasMessageText === "false"
              );
            }),
          };
        }, domBeforeLiveness),
      ]);
      const domSnapshot =
        domSnapshotResult?.status === "fulfilled"
          ? domSnapshotResult.value
          : null;
      const originalErrorName =
        error instanceof Error &&
        ["Error", "AssertionError", "LivenessAssertionError"].includes(
          error.name,
        )
          ? error.name
          : "UnknownError";
      const diagnostic = [
        `originalErrorName=${originalErrorName}`,
        `chatSendAttemptDelta=${Math.max(0, auditAfterLiveness.chatSendAttemptCount - auditBeforeLiveness.chatSendAttemptCount)}`,
        `logicalChatSendDelta=${Math.max(0, auditAfterLiveness.logicalChatSendCount - auditBeforeLiveness.logicalChatSendCount)}`,
        `unidentifiedChatSendDelta=${Math.max(0, auditAfterLiveness.unidentifiedChatSendAttemptCount - auditBeforeLiveness.unidentifiedChatSendAttemptCount)}`,
        `namedWarmingResponseDelta=${Math.max(0, auditAfterLiveness.namedWarmingResponseCount - auditBeforeLiveness.namedWarmingResponseCount)}`,
        `successfulChatResponseDelta=${Math.max(0, auditAfterLiveness.successfulChatSendResponseCount - auditBeforeLiveness.successfulChatSendResponseCount)}`,
        `clientErrorChatResponseDelta=${Math.max(0, auditAfterLiveness.clientErrorChatSendResponseCount - auditBeforeLiveness.clientErrorChatSendResponseCount)}`,
        `serverErrorChatResponseDelta=${Math.max(0, auditAfterLiveness.serverErrorChatSendResponseCount - auditBeforeLiveness.serverErrorChatSendResponseCount)}`,
        `otherChatResponseDelta=${Math.max(0, auditAfterLiveness.otherChatSendResponseCount - auditBeforeLiveness.otherChatSendResponseCount)}`,
        `retryObservationAvailable=${retryObservation.ok}`,
        `retryChipEverObserved=${retryObservation.ok ? retryObservation.retryChipEverObserved : "unavailable"}`,
        `domSnapshotAvailable=${domSnapshot !== null}`,
        `draftCleared=${domSnapshot?.draftCleared ?? "unavailable"}`,
        `newUserRowCount=${domSnapshot?.newUserRowCount ?? "unavailable"}`,
        `newAssistantRowCount=${domSnapshot?.newAssistantRowCount ?? "unavailable"}`,
        `failureRowPresent=${domSnapshot?.failureRowPresent ?? "unavailable"}`,
        `retryRowPresent=${domSnapshot?.retryRowPresent ?? "unavailable"}`,
        `interruptedRowPresent=${domSnapshot?.interruptedRowPresent ?? "unavailable"}`,
        `widgetOnlyReplyRowPresent=${domSnapshot?.widgetOnlyReplyRowPresent ?? "unavailable"}`,
      ].join("; ");
      throw new Error(
        `Cloud live liveness failed; privacy-safe diagnostic: ${diagnostic}`,
      );
    }
    if (!retryObservation.ok && REQUIRE_NAMED_WARMING) {
      throw new Error(
        "Cloud live Retry-chip observer failed; named warming proof is unavailable",
      );
    }
    const { liveness } = livenessAttempt;
    const retryChipEverObserved = retryObservation.ok
      ? retryObservation.retryChipEverObserved
      : false;
    test.info().annotations.push({
      type: "first-turn-latency-ms",
      description: String(liveness.firstTurnLatencyMs),
    });
    const challengeAudit = await primaryAudit.snapshot();
    assertCloudLiveNamedWarmingProof({
      required: REQUIRE_NAMED_WARMING,
      terminalLivenessPassed: isLiveReply(liveness.reply),
      chatSendAttemptCount:
        challengeAudit.chatSendAttemptCount -
        auditBeforeLiveness.chatSendAttemptCount,
      logicalChatSendCount:
        challengeAudit.logicalChatSendCount -
        auditBeforeLiveness.logicalChatSendCount,
      unidentifiedChatSendAttemptCount:
        challengeAudit.unidentifiedChatSendAttemptCount -
        auditBeforeLiveness.unidentifiedChatSendAttemptCount,
      namedWarmingResponseCount:
        challengeAudit.namedWarmingResponseCount -
        auditBeforeLiveness.namedWarmingResponseCount,
      retryChipEverObserved,
    });
    const challengeLogicalChatSendCount = challengeAudit.logicalChatSendCount;
    expect(challengeLogicalChatSendCount).toBe(1);
    expect(challengeAudit.unidentifiedChatSendAttemptCount).toBe(0);

    // Reload the same document partition. A successful server history GET plus
    // both turn-anchored rows proves the turn did not survive merely in React
    // memory. Private binding values are reduced to booleans before evidence.
    const reloadHistoryBefore = (await primaryAudit.snapshot())
      .successfulHistoryGetCount;
    await page.reload({ waitUntil: "domcontentloaded" });
    const reload = await proveAnchoredTurnHistory(
      page,
      primaryAudit,
      reloadHistoryBefore,
      turnAnchorToken,
    );
    const reloadBindingReuse = compareCloudLiveRuntimeBindings(
      referenceBinding,
      await requireActiveBinding(page),
    );

    expect(
      baseURL,
      "Playwright baseURL is required for a fresh context",
    ).toBeTruthy();
    const freshResult = await (async () => {
      // Deliberately omit storageState. The new context gets no cookies or
      // origins from the first one, blocks the production service worker, and
      // receives only explicit blank boot values. Deployed mode hands it the
      // protected bearer only after its public top-level origin is verified.
      const freshContext = await browser.newContext({
        baseURL,
        serviceWorkers: "block",
      });
      try {
        const pristineState = await freshContext.storageState();
        const createdWithoutStorageState =
          pristineState.cookies.length === 0 &&
          pristineState.origins.length === 0;
        expect(createdWithoutStorageState).toBe(true);

        const freshPage = await freshContext.newPage();
        const freshAudit = installNetworkAudit(freshContext);
        const { deployedRenderer: freshDeployedRenderer } =
          await openProtectedCloudBlankStart(
            freshPage,
            baseURL,
            originContract.origin,
          );
        if (DEPLOYED_RENDERER_ENABLED) {
          expect(freshDeployedRenderer).toEqual(deployedRenderer);
        }
        const freshBinding = await resolvePersonalIdentity(freshPage);
        const freshHistoryBefore = (await freshAudit.snapshot())
          .successfulHistoryGetCount;
        await openAppPath(freshPage, "/chat");
        const history = await proveAnchoredTurnHistory(
          freshPage,
          freshAudit,
          freshHistoryBefore,
          turnAnchorToken,
        );
        return {
          history: {
            ...history,
            createdWithoutStorageState,
            serviceWorkersBlocked: true,
          },
          bindingReuse: compareCloudLiveRuntimeBindings(
            referenceBinding,
            freshBinding,
          ),
          audit: await freshAudit.snapshot(),
        };
      } finally {
        await freshContext.close();
      }
    })();

    const primarySnapshot = await primaryAudit.snapshot();
    const personalIdentityEndpointPassed =
      primarySnapshot.successfulPersonalIdentityGetCount > 0 &&
      freshResult.audit.successfulPersonalIdentityGetCount > 0;
    expect(personalIdentityEndpointPassed).toBe(true);
    const noAdditionalChatSendAfterChallenge =
      primarySnapshot.logicalChatSendCount === challengeLogicalChatSendCount &&
      primarySnapshot.unidentifiedChatSendAttemptCount === 0 &&
      freshResult.audit.logicalChatSendCount === 0 &&
      freshResult.audit.unidentifiedChatSendAttemptCount === 0;
    expect(noAdditionalChatSendAfterChallenge).toBe(true);
    const forbiddenAgentMutationCount =
      primarySnapshot.forbiddenAgentMutationCount +
      freshResult.audit.forbiddenAgentMutationCount;
    expect(forbiddenAgentMutationCount).toBe(0);
    const bindingReuse: CloudLiveBindingReuse = {
      personalIdentityReused:
        reloadBindingReuse.personalIdentityReused &&
        freshResult.bindingReuse.personalIdentityReused,
      runtimeBindingReused:
        reloadBindingReuse.runtimeBindingReused &&
        freshResult.bindingReuse.runtimeBindingReused,
      apiBaseReused:
        reloadBindingReuse.apiBaseReused &&
        freshResult.bindingReuse.apiBaseReused,
    };

    // No agent was created by this test, so there is nothing honest to delete.
    // The successful reload + fresh-context read is the cleanup state we want:
    // preserve the account-owned conversation history exactly where it lives.
    const continuityEvidenceInput = {
      challengeTurnCount: 1,
      noAdditionalChatSendAfterChallenge,
      personalIdentityEndpointPassed,
      reload,
      freshContext: freshResult.history,
      bindingReuse,
      forbiddenAgentMutationCount,
      cleanupDisposition: "no-test-owned-agent",
      conversationHistoryDisposition: "preserved",
    } satisfies CloudLiveContinuityEvidenceInput;
    createCloudLiveContinuityEvidence(continuityEvidenceInput);

    if (originContract.environment === "staging") {
      await writeStagingCloudChatLatencyEvidence(
        stagingLatencyEvidencePath,
        liveness.firstTurnLatencyMs,
      );
      await writeCloudLiveContinuityEvidence(
        stagingContinuityEvidencePath,
        continuityEvidenceInput,
      );
      if (DEPLOYED_RENDERER_ENABLED) {
        expect(deployedRenderer).not.toBeNull();
        await writeDeployedBrowserSmokeEvidence(
          deployedBrowserEvidencePath,
          deployedRenderer as DeployedRendererIdentity,
          originContract.origin,
        );
      }
    }
  });
});
