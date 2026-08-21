/**
 * Exercises real login, Personal Eliza identity resolution, and chat through
 * Eliza Cloud, without mocking cloud endpoints. The opt-in workflow must supply
 * both live-stack flags and ELIZAOS_CLOUD_API_KEY; this test spends real cloud
 * credits and must never run in a keyless PR lane.
 */

import { randomBytes } from "node:crypto";
import { resolveDirectCloudAuthApiBase } from "@elizaos/ui/api/direct-cloud-endpoints";
import { isPersonalSharedElizaId } from "@elizaos/ui/utils/cloud-agent-base";
import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { seedCloudLiveBrowserAuth } from "../cloud-live-browser-auth";
import {
  type CloudLiveBindingReuse,
  type CloudLiveContinuityEvidenceInput,
  type CloudLiveHistoryObservation,
  type CloudLiveRuntimeBinding,
  compareCloudLiveRuntimeBindings,
  createCloudLiveContinuityEvidence,
  createCloudLiveNetworkAudit,
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
    // error-policy:J4 the only expected failure of this wait is "the optional
    // affordance never appeared", which becomes a distinct absent state; the
    // click below still surfaces any genuine interaction failure.
    () => false,
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
  expect(
    await seedCloudLiveBrowserAuth({
      async addInitScript(script, seed) {
        await page.addInitScript(script, seed);
      },
    }),
    "Cloud-live mode must hand its validated workflow bearer to the browser",
  ).toBe(true);
  await page.addInitScript(() => {
    // Do not use the general smoke seed: its local active-server fixture would
    // invalidate a fresh-context continuity claim. These explicit empty values
    // plus the protected bearer above are the only values the test seeds.
    if (localStorage.getItem("eliza:first-run-complete") === null) {
      localStorage.setItem("eliza:first-run-complete", "");
    }
    if (localStorage.getItem("elizaos:active-server") === null) {
      localStorage.setItem("elizaos:active-server", "");
    }
  });
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
    audit.observeResponse(
      response.request().method(),
      response.url(),
      response.status(),
    );
  });
  return audit;
}

async function proveAnchoredTurnHistory(
  page: Page,
  audit: ReturnType<typeof createCloudLiveNetworkAudit>,
  priorCount: number,
  turnAnchorToken: string,
): Promise<CloudLiveHistoryObservation> {
  await expect
    .poll(() => audit.snapshot().successfulHistoryGetCount > priorCount, {
      timeout: 120_000,
    })
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
    !CLOUD_LIVE_ENABLED,
    "set ELIZA_UI_SMOKE_CLOUD_LIVE=1 and ELIZA_UI_SMOKE_LIVE_STACK=1 to run against real Eliza Cloud",
  );
  test.skip(
    !HAS_CLOUD_KEY,
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
        // This lane always drives the renderer bundle built from the checked-out
        // revision through the live stack; it does NOT drive a deployed Pages
        // artifact. Recorded so run artifacts state what was exercised.
        type: "renderer-source",
        description: "locally built renderer bundle (not a deployed artifact)",
      },
    );
    expect(
      originContract.ok,
      originContract.reason ??
        `resolved Cloud API origin: ${originContract.origin}`,
    ).toBe(true);

    const stagingLatencyEvidencePath =
      process.env.ELIZA_UI_SMOKE_STAGING_CHAT_LATENCY_EVIDENCE_PATH?.trim() ??
      "";
    const stagingContinuityEvidencePath =
      process.env.ELIZA_UI_SMOKE_STAGING_CONTINUITY_EVIDENCE_PATH?.trim() ?? "";
    if (originContract.environment === "staging") {
      expect(
        stagingLatencyEvidencePath,
        "the staging lane must persist its privacy-safe chat latency artifact",
      ).toBeTruthy();
      expect(
        stagingContinuityEvidencePath,
        "the staging lane must persist its privacy-safe continuity artifact",
      ).toBeTruthy();
    }

    const primaryAudit = installNetworkAudit(context);
    await seedProtectedCloudBlankStart(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The process-level contract above only pins the spawned runtime's proxy.
    // The renderer carries its own Cloud base, resolved at BUILD time from
    // VITE_ELIZA_CLOUD_BASE and otherwise defaulted, and the shared-agent base
    // for the chat leg is derived from it
    // (client-cloud.ts buildCloudSharedAgentApiBase). A bundle built for the
    // wrong deployment therefore talks to the wrong Cloud with this lane's
    // bearer. Compare through resolveDirectCloudAuthApiBase because the boot
    // value is a SITE base ("https://eliza.app") while the contract exposes an
    // API origin ("https://api.eliza.app") -- equivalent, differently spelled.
    const readRendererCloudBase = () =>
      page.evaluate(() => {
        const config = (
          window as unknown as {
            __ELIZAOS_APP_BOOT_CONFIG__?: { cloudApiBase?: string };
          }
        ).__ELIZAOS_APP_BOOT_CONFIG__;
        return config?.cloudApiBase?.trim() ?? "";
      });
    // The public shell hands off to the full app asynchronously after the
    // document event. Wait only for the non-secret boot mirror to exist; once
    // present, the exact-origin assertion below still fails immediately on a
    // production or malformed value.
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
    test.info().annotations.push({
      type: "renderer-cloud-origin",
      description: rendererApiOrigin,
    });
    expect(
      rendererApiOrigin,
      `renderer bundle resolves ${rendererCloudBase || "<unset>"} -> ${rendererApiOrigin || "<empty>"}; the lane pinned ${originContract.origin}`,
    ).toBe(originContract.origin);

    // The current Cloud join flow resolves the account-derived Personal Eliza
    // identity through the read-only Personal endpoint. It persists the
    // account-owned binding without creating dedicated compute.
    const referenceBinding = await resolvePersonalIdentity(page);
    expect(
      primaryAudit.snapshot().successfulPersonalIdentityGetCount,
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
    const auditBeforeLiveness = primaryAudit.snapshot();
    const domBeforeLiveness = await page.evaluate(() => ({
      userRowCount: document.querySelectorAll(
        '[data-testid="thread-line"][data-role="user"]',
      ).length,
      assistantRowCount: document.querySelectorAll(
        '[data-testid="thread-line"][data-role="assistant"]',
      ).length,
    }));
    const liveness = await (async () => {
      try {
        return await assertOnboardingLivenessWithTiming(page, {
          label: "cloud-live",
          prompt: turnPrompt,
          turnAnchorToken,
        });
      } catch (error) {
        // error-policy:J3 reduce the original assertion and live browser state
        // to an allowlisted name plus counts/booleans only. Never emit the draft,
        // challenge, response text, request URL, or any account/runtime ID.
        const auditAfterLiveness = primaryAudit.snapshot();
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
              draftCleared: composer
                ? composer.value.trim().length === 0
                : null,
              newUserRowCount: Math.max(
                0,
                userRows.length - before.userRowCount,
              ),
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
          `successfulChatResponseDelta=${Math.max(0, auditAfterLiveness.successfulChatSendResponseCount - auditBeforeLiveness.successfulChatSendResponseCount)}`,
          `clientErrorChatResponseDelta=${Math.max(0, auditAfterLiveness.clientErrorChatSendResponseCount - auditBeforeLiveness.clientErrorChatSendResponseCount)}`,
          `serverErrorChatResponseDelta=${Math.max(0, auditAfterLiveness.serverErrorChatSendResponseCount - auditBeforeLiveness.serverErrorChatSendResponseCount)}`,
          `otherChatResponseDelta=${Math.max(0, auditAfterLiveness.otherChatSendResponseCount - auditBeforeLiveness.otherChatSendResponseCount)}`,
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
    })();
    test.info().annotations.push({
      type: "first-turn-latency-ms",
      description: String(liveness.firstTurnLatencyMs),
    });
    const challengeAudit = primaryAudit.snapshot();
    const challengeLogicalChatSendCount = challengeAudit.logicalChatSendCount;
    expect(challengeLogicalChatSendCount).toBe(1);
    expect(challengeAudit.unidentifiedChatSendAttemptCount).toBe(0);

    // Reload the same document partition. A successful server history GET plus
    // both turn-anchored rows proves the turn did not survive merely in React
    // memory. Private binding values are reduced to booleans before evidence.
    const reloadHistoryBefore =
      primaryAudit.snapshot().successfulHistoryGetCount;
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
      // receives only the protected bearer + explicit blank boot values.
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
        await seedProtectedCloudBlankStart(freshPage);
        await freshPage.goto("/", { waitUntil: "domcontentloaded" });
        const freshBinding = await resolvePersonalIdentity(freshPage);
        const freshHistoryBefore =
          freshAudit.snapshot().successfulHistoryGetCount;
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
          audit: freshAudit.snapshot(),
        };
      } finally {
        await freshContext.close();
      }
    })();

    const primarySnapshot = primaryAudit.snapshot();
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
    }
  });
});
