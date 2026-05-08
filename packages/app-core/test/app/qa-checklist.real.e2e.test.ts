import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { describeIf } from "../helpers/conditional-tests.ts";
import { selectLiveProvider } from "../helpers/live-provider";

const envPath = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  ".env",
);
try {
  const { config } = await import("dotenv");
  config({ path: envPath });
} catch {
  // Keys may already be present in process.env.
}

const DEFAULT_UI_URL = stripTrailingSlash(
  process.env.ELIZA_LIVE_UI_URL ??
    process.env.ELIZA_UI_URL ??
    "http://localhost:2138",
);
let API_URL = stripTrailingSlash(
  process.env.ELIZA_LIVE_API_URL ??
    process.env.ELIZA_API_URL ??
    "http://127.0.0.1:31337",
);
const API_TOKEN = process.env.ELIZA_API_TOKEN?.trim() ?? "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY?.trim() ?? "";
const CHROME_PATH =
  process.env.ELIZA_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const CHROME_AVAILABLE = existsSync(CHROME_PATH);
const LIVE_PROVIDER =
  (LIVE_TESTS_ENABLED && selectLiveProvider("groq")) ||
  (LIVE_TESTS_ENABLED ? selectLiveProvider() : null);
const LIVE_PROVIDER_LABELS = {
  anthropic: "Anthropic",
  google: "Gemini",
  groq: "Groq",
  openai: "OpenAI",
  openrouter: "OpenRouter",
} as const;
const LIVE_PROVIDER_LABEL = LIVE_PROVIDER
  ? LIVE_PROVIDER_LABELS[LIVE_PROVIDER.name]
  : null;
const REQUIRE_STRICT_TTS_ASSERTIONS = ELEVENLABS_API_KEY.length > 0;
const CAN_RUN =
  LIVE_TESTS_ENABLED && CHROME_AVAILABLE && LIVE_PROVIDER !== null;
const PROFILE_FILTER = new Set(
  (process.env.ELIZA_LIVE_PROFILE ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const EXPECTED_SARAH_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
const KNOWLEDGE_CODEWORD = "VELVET-MOON-4821";
const QA_ARTIFACT_DIR = path.join(os.tmpdir(), "eliza-live-qa");
const REPO_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const APP_DIR = path.join(REPO_ROOT, "packages", "app");
const APP_DIST_DIR = path.join(APP_DIR, "dist");
const STACK_READY_TIMEOUT_MS = 120_000;
const RESET_TRANSITION_GRACE_MS = 10_000;

type QaFetchRecord = {
  url: string;
  method: string;
  status?: number;
  error?: string;
};

type QaRequestFailure = {
  method: string;
  url: string;
  errorText: string;
  duringResetTransition: boolean;
};

type QaEmoteEventRecord = {
  type: string;
  emoteId: string | null;
  path: string | null;
  duration: number | null;
  loop: boolean | null;
  at: number;
};

type QaPlayEmoteRecord = {
  role: string | null;
  vrmPath: string | null;
  path: string | null;
  duration: number | null;
  loop: boolean | null;
  at: number;
};

type QaTeleportRecord = {
  type: string;
  at: number;
};

type QaVrmRegistryEntry = {
  role: string | null;
  vrmPath: string | null;
  worldUrl: string | null;
  avatarLoaded: boolean;
  avatarReady: boolean;
  cameraProfile: string | null;
};

type QaVoiceStats = {
  audioStarts: number;
  speechCalls: number;
  ttsFetches: QaFetchRecord[];
};

type QaRemoteSnapshot = {
  activeServer: string | null;
  bodyText: string;
  connectButtonText: string | null;
  remoteApiBase: string;
  remoteError: string | null;
  remoteTokenLength: number;
};

type CharacterRosterState = {
  labels: string[];
  selectedLabel: string | null;
  selectedTestId: string | null;
};

type CharacterRosterEntryState = {
  label: string;
  testId: string | null;
  selected: boolean;
  previewSrc: string | null;
};

type Profile = {
  id: "desktop" | "mobile";
  label: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
  };
  userAgent?: string;
};

type StartedStack = {
  apiBase: string;
  apiChild: ChildProcessWithoutNullStreams;
  stateDir: string;
  uiBase: string;
  uiServer: Server;
};

const PROFILES: Profile[] = [
  {
    id: "desktop",
    label: "Desktop",
    viewport: {
      width: 1440,
      height: 980,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
  },
  {
    id: "mobile",
    label: "Mobile",
    viewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
  },
];
const ACTIVE_PROFILES =
  PROFILE_FILTER.size > 0
    ? PROFILES.filter((profile) => PROFILE_FILTER.has(profile.id))
    : PROFILES;

function logQaStep(profile: Profile, step: string) {
  console.log(`[live-qa][${profile.id}] ${step}`);
}

function formatQaRequestFailure(failure: QaRequestFailure): string {
  return `${failure.method} ${failure.url} (${failure.errorText})`;
}

function isIgnorableQaRequestFailure(failure: QaRequestFailure): boolean {
  let pathname = "/";
  try {
    pathname = new URL(failure.url).pathname;
  } catch {
    return false;
  }

  if (
    failure.errorText === "net::ERR_ABORTED" &&
    pathname === "/api/coding-agents/preflight"
  ) {
    return true;
  }

  if (
    (failure.errorText === "net::ERR_FAILED" ||
      failure.errorText === "net::ERR_ABORTED") &&
    ["/api/config", "/api/onboarding/status", "/api/vincent/status"].includes(
      pathname,
    )
  ) {
    return true;
  }

  return (
    failure.duringResetTransition &&
    (failure.errorText === "net::ERR_FAILED" ||
      failure.errorText === "net::ERR_ABORTED") &&
    pathname.startsWith("/api/")
  );
}

function actionableQaRequestFailures(failures: QaRequestFailure[]): string[] {
  return failures
    .filter((failure) => !isIgnorableQaRequestFailure(failure))
    .map(formatQaRequestFailure);
}

let browser: Browser | null = null;
let UI_URL = DEFAULT_UI_URL;
let liveStack: StartedStack | null = null;

describeIf(CAN_RUN)("Live QA checklist", () => {
  beforeAll(async () => {
    if (!CAN_RUN) return;
    console.log("[live-qa][setup] create artifact dir");
    await fs.mkdir(QA_ARTIFACT_DIR, { recursive: true });
    console.log("[live-qa][setup] start real stack");
    liveStack = await startRealStack();
    API_URL = stripTrailingSlash(liveStack.apiBase);
    UI_URL = stripTrailingSlash(liveStack.uiBase);
    console.log(`[live-qa][setup] stack ready ui=${UI_URL} api=${API_URL}`);
    await ensureHttpOk(`${UI_URL}/`);
    console.log("[live-qa][setup] ui reachable");
    await ensureHttpOk(`${API_URL}/api/status`);
    console.log("[live-qa][setup] api reachable");
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      protocolTimeout: 300_000,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--use-angle=swiftshader",
      ],
    });
    console.log("[live-qa][setup] browser launched");
  }, 120_000);

  afterAll(async () => {
    if (!CAN_RUN) return;
    await browser?.close();
    await stopRealStack(liveStack);
    liveStack = null;
  }, 30_000);

  for (const profile of ACTIVE_PROFILES) {
    it(`${profile.label}: completes the real QA checklist`, async () => {
      const activeBrowser = ensureBrowser(browser);
      const context = await activeBrowser.createBrowserContext();
      const origin = new URL(UI_URL).origin;
      await context.overridePermissions(origin, ["camera", "microphone"]);

      const page = await context.newPage();
      await page.setViewport(profile.viewport);
      if (profile.userAgent) {
        await page.setUserAgent(profile.userAgent);
      }
      page.setDefaultTimeout(45_000);
      page.setDefaultNavigationTimeout(60_000);

      const pageErrors: string[] = [];
      const sameOriginFailures: QaRequestFailure[] = [];
      let resetTransitionStartedAt: number | null = null;
      let sameOriginFailureCountBeforeReset: number | null = null;
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
      });
      page.on("requestfailed", (request) => {
        const requestFailedAt = Date.now();
        const url = request.url();
        if (
          url.startsWith(UI_URL) ||
          url.startsWith(API_URL) ||
          url.startsWith(new URL(UI_URL).origin)
        ) {
          sameOriginFailures.push({
            method: request.method(),
            url,
            errorText: request.failure()?.errorText ?? "requestfailed",
            duringResetTransition:
              resetTransitionStartedAt !== null &&
              requestFailedAt >=
                resetTransitionStartedAt - RESET_TRANSITION_GRACE_MS,
          });
        }
      });
      page.on("dialog", async (dialog) => {
        await dialog.accept();
      });

      await installQaInstrumentation(page);
      logQaStep(profile, "reset agent");
      await resetAgentViaApi();

      const documentFile = await writeDocumentFile(profile.id);
      const documentUploadName = path.basename(documentFile);
      const documentNames = [
        documentUploadName,
        path.parse(documentUploadName).name,
      ];
      try {
        logQaStep(profile, "open onboarding");
        await navigate(page, `${UI_URL}/?test_force_vrm=1`);

        logQaStep(profile, "complete local provider onboarding");
        await completeLocalProviderOnboarding(page);

        expect(await onboardingComplete()).toBe(true);
        logQaStep(profile, "enter companion mode");
        await enterCompanionMode(page);
        await waitForCompanionReady(page, 120_000);
        logQaStep(profile, "companion shell ready");

        if (REQUIRE_STRICT_TTS_ASSERTIONS) {
          const voiceConfig = await waitFor(async () => {
            const config = await apiJson<{
              messages?: {
                tts?: {
                  provider?: string;
                  elevenlabs?: { voiceId?: string };
                };
              };
            }>("/api/config");
            const tts = config?.messages?.tts;
            return tts?.provider === "elevenlabs" ? tts : null;
          }, 60_000);
          expect(voiceConfig.elevenlabs?.voiceId).toBe(EXPECTED_SARAH_VOICE_ID);
        }
        await page.evaluate(() => {
          window.dispatchEvent(new Event("eliza:vrm-teleport-complete"));
        });
        await page.waitForSelector('[data-testid="chat-composer-textarea"]');
        await page.mouse.click(24, 24);

        logQaStep(profile, "create new chat");
        const conversationsBefore = await listConversations();
        const greetingVoiceSignals = await qaVoiceStats(page);
        await clickSelector(page, 'button[aria-label="New Chat"]');

        const activeConversation = await waitFor(async () => {
          const conversations = await listConversations();
          return conversations.length === conversationsBefore.length + 1
            ? conversations[0]
            : null;
        }, 30_000);

        const greetingMessage = await waitFor(async () => {
          const messages = await listMessages(activeConversation.id);
          return (
            messages.find((message) => message.role === "assistant") ?? null
          );
        }, 30_000);

        expectValidGreetingMessage(greetingMessage.text);
        logQaStep(profile, "wait for greeting voice playback");
        await maybeWaitForVoicePlayback(page, greetingVoiceSignals, 45_000);
        logQaStep(profile, "verify greeting text is visible");
        await waitForText(page, greetingMessage.text);

        const responseVoiceSignals = await qaVoiceStats(page);
        logQaStep(profile, "send user message");
        await typeComposerAndSend(
          page,
          "reply with exactly these two words: hello there",
        );

        const replyMessage = await waitFor(async () => {
          const messages = await listMessages(activeConversation.id);
          const assistants = messages.filter(
            (message) => message.role === "assistant",
          );
          if (assistants.length < 2) return null;
          const latest = assistants[assistants.length - 1];
          return latest.text !== greetingMessage.text ? latest : null;
        }, 90_000);

        expect(normalizeText(replyMessage.text)).toContain("hello there");
        logQaStep(profile, "wait for assistant reply voice playback");
        await maybeWaitForOptionalVoicePlayback(
          page,
          responseVoiceSignals,
          45_000,
        );

        logQaStep(profile, "enable trajectories and upload document");
        await apiJson("/api/trajectories/config", {
          method: "PUT",
          body: JSON.stringify({ enabled: true }),
        });

        await clickSelector(
          page,
          '[data-testid="companion-shell-toggle-desktop"]',
        );
        await navigate(page, `${UI_URL}/knowledge`);
        await page.waitForSelector('[data-testid="knowledge-view"]', {
          visible: true,
        });
        await page.waitForSelector(
          '[data-testid="knowledge-view"] input[type="file"]',
        );

        const uploadInput = await page.waitForSelector(
          '[data-testid="knowledge-view"] input[type="file"]',
        );
        expect(uploadInput).toBeTruthy();
        if (!uploadInput) {
          throw new Error("Document upload input was not found.");
        }
        await uploadInput.uploadFile(documentFile);

        const uploadedDocument = await waitFor(
          async () => {
            const docs = await listDocuments();
            return (
              docs.find((document) =>
                documentNames.includes(document.filename),
              ) ?? null
            );
          },
          120_000,
          2000,
        );

        expect(documentNames).toContain(uploadedDocument.filename);
        await waitFor(
          async () => {
            const text = await page.evaluate(
              () => document.body.innerText ?? "",
            );
            return documentNames.some((name) => text.includes(name))
              ? true
              : null;
          },
          120_000,
          1000,
        );

        await waitFor(
          async () => {
            const results = await documentSearch("qa codeword");
            return results.some((result) =>
              String(result.text ?? "")
                .toUpperCase()
                .includes(KNOWLEDGE_CODEWORD),
            );
          },
          120_000,
          2000,
        );

        await navigate(page, `${UI_URL}/chat`);
        await page.waitForSelector('[data-testid="chat-composer-textarea"]');
        await typeComposerAndSend(
          page,
          "what is the qa codeword from the uploaded file? answer with only the codeword",
        );

        const knowledgeReply = await waitFor(async () => {
          const messages = await listMessages(activeConversation.id);
          return (
            [...messages].reverse().find(
              (message) =>
                message.role === "assistant" &&
                String(message.text ?? "")
                  .toUpperCase()
                  .includes(KNOWLEDGE_CODEWORD),
            ) ?? null
          );
        }, 90_000);
        expect(knowledgeReply.text.toUpperCase()).toContain(KNOWLEDGE_CODEWORD);

        logQaStep(profile, "verify trajectory contents");
        const matchingTrajectory = await waitFor(
          async () => {
            const list = await apiJson<{ trajectories: Array<{ id: string }> }>(
              "/api/trajectories?limit=20",
            );
            for (const trajectory of list.trajectories ?? []) {
              const detail = await apiJson<{
                llmCalls?: Array<{
                  userPrompt?: string;
                  response?: string;
                }>;
              }>(`/api/trajectories/${encodeURIComponent(trajectory.id)}`);
              const match = (detail.llmCalls ?? []).find((call) => {
                const prompt = String(call.userPrompt ?? "").toLowerCase();
                return prompt.includes("qa codeword from the uploaded file");
              });
              if (match) {
                return { detail, match };
              }
            }
            return null;
          },
          90_000,
          2000,
        );

        expect(String(matchingTrajectory.match.userPrompt)).toContain(
          "qa codeword from the uploaded file",
        );
        expect(
          String(matchingTrajectory.match.response).toUpperCase(),
        ).toContain(KNOWLEDGE_CODEWORD);

        await navigate(page, `${UI_URL}/trajectories`);
        await page.waitForSelector('[data-testid="trajectories-view"]');
        const trajectorySearchSelector =
          '[data-testid="trajectories-sidebar"] input[type="text"]';
        if (await isSelectorVisible(page, trajectorySearchSelector)) {
          await typeInto(
            page,
            trajectorySearchSelector,
            "qa codeword from the uploaded file",
          );
          await page.waitForSelector(
            '[data-testid="trajectories-sidebar"] [data-sidebar-item]',
          );
        }
        await waitForText(page, "qa codeword from the uploaded file", 30_000);
        await waitForText(page, KNOWLEDGE_CODEWORD, 30_000);

        logQaStep(profile, "smoke tabs");
        await smokeTabs(page, profile);
        logQaStep(profile, "wallet rpc provider roundtrip");
        await qaWalletRpcRoundtrip(page, profile);
        logQaStep(profile, "verify character switch dance emote and voice");
        await qaCharacterSwitchAndDance(page, profile);

        logQaStep(profile, "reset back to onboarding");
        await navigate(page, `${UI_URL}/settings`);
        await waitForText(page, "Reset Agent");
        // The final reset intentionally tears down the current API/UI ports.
        // Ignore same-origin requestfailed noise from the old stack while the
        // shell reconnects; the explicit post-reset assertions below verify the
        // actual final state instead.
        sameOriginFailureCountBeforeReset = sameOriginFailures.length;
        resetTransitionStartedAt = Date.now();
        await clickByText(page, "Reset Everything");
        await waitForOnboardingEntry(page, 180_000);

        expect(await onboardingComplete()).toBe(false);
        expect((await listConversations()).length).toBe(0);
        expect((await listDocumentsAfterReset()).length).toBe(0);
        await saveScreenshot(page, profile, "reset-to-onboarding");

        expect(pageErrors).toEqual([]);
        expect(
          actionableQaRequestFailures(
            sameOriginFailures.slice(
              0,
              sameOriginFailureCountBeforeReset ?? sameOriginFailures.length,
            ),
          ),
        ).toEqual([]);
      } catch (error) {
        await saveFailureArtifacts(page, profile, error);
        throw error;
      } finally {
        await fs.rm(documentFile, { force: true });
        await context.close();
      }
    }, 600_000);

    it(`${profile.label}: validates avatar state, voice, and character switching`, async () => {
      const activeBrowser = ensureBrowser(browser);
      const context = await activeBrowser.createBrowserContext();
      const origin = new URL(UI_URL).origin;
      await context.overridePermissions(origin, ["camera", "microphone"]);

      const page = await context.newPage();
      await page.setViewport(profile.viewport);
      if (profile.userAgent) {
        await page.setUserAgent(profile.userAgent);
      }
      page.setDefaultTimeout(45_000);
      page.setDefaultNavigationTimeout(60_000);

      const pageErrors: string[] = [];
      const sameOriginFailures: QaRequestFailure[] = [];
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
      });
      page.on("requestfailed", (request) => {
        const url = request.url();
        if (
          url.startsWith(UI_URL) ||
          url.startsWith(API_URL) ||
          url.startsWith(new URL(UI_URL).origin)
        ) {
          sameOriginFailures.push({
            method: request.method(),
            url,
            errorText: request.failure()?.errorText ?? "requestfailed",
            duringResetTransition: false,
          });
        }
      });
      page.on("dialog", async (dialog) => {
        await dialog.accept();
      });

      await installQaInstrumentation(page);
      logQaStep(profile, "avatar-voice QA reset agent");
      await resetAgentViaApi();

      try {
        logQaStep(profile, "avatar-voice QA open onboarding");
        await navigate(page, `${UI_URL}/?test_force_vrm=1`);

        logQaStep(
          profile,
          "avatar-voice QA complete local provider onboarding",
        );
        await completeLocalProviderOnboarding(page);

        logQaStep(profile, "avatar-voice QA enter companion mode");
        await enterCompanionMode(page);

        logQaStep(profile, "avatar-voice QA verify companion avatar");
        await waitForCompanionReady(page, 120_000);
        logQaStep(profile, "avatar-voice QA companion avatar ready");
        await page.evaluate(() => {
          window.dispatchEvent(new Event("eliza:vrm-teleport-complete"));
        });
        await page.waitForSelector('[data-testid="chat-composer-textarea"]');
        await page.mouse.click(24, 24);

        logQaStep(profile, "avatar-voice QA create new chat");
        const conversationsBefore = await listConversations();
        const greetingVoiceSignals = await qaVoiceStats(page);
        await clickSelector(page, 'button[aria-label="New Chat"]');

        const activeConversation = await waitFor(async () => {
          const conversations = await listConversations();
          return conversations.length === conversationsBefore.length + 1
            ? conversations[0]
            : null;
        }, 30_000);

        const greetingMessage = await waitFor(async () => {
          const messages = await listMessages(activeConversation.id);
          return (
            messages.find((message) => message.role === "assistant") ?? null
          );
        }, 30_000);
        expectValidGreetingMessage(greetingMessage.text);
        await maybeWaitForVoicePlayback(page, greetingVoiceSignals, 45_000);
        await waitForText(page, greetingMessage.text);

        logQaStep(profile, "avatar-voice QA validate reply voice");
        const responseVoiceSignals = await qaVoiceStats(page);
        await typeComposerAndSend(
          page,
          "reply with exactly these two words: hello there",
        );
        const replyMessage = await waitFor(async () => {
          const messages = await listMessages(activeConversation.id);
          const assistants = messages.filter(
            (message) => message.role === "assistant",
          );
          if (assistants.length < 2) return null;
          const latest = assistants[assistants.length - 1];
          return latest.text !== greetingMessage.text ? latest : null;
        }, 90_000);
        expect(normalizeText(replyMessage.text)).toContain("hello there");
        await maybeWaitForOptionalVoicePlayback(
          page,
          responseVoiceSignals,
          45_000,
        );

        logQaStep(
          profile,
          "avatar-voice QA validate character switch dance and emotes",
        );
        await qaCharacterSwitchAndDance(page, profile);

        expect(pageErrors).toEqual([]);
        expect(actionableQaRequestFailures(sameOriginFailures)).toEqual([]);
      } catch (error) {
        await saveFailureArtifacts(page, profile, error);
        throw error;
      } finally {
        await context.close();
      }
    }, 420_000);
  }
});

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function injectQaBootScript(html: string, apiBase: string): string {
  const bootScript = `<script>window.__ELIZA_API_BASE__=${JSON.stringify(apiBase)};${API_TOKEN ? `Object.defineProperty(window,"__ELIZA_API_TOKEN__",{value:${JSON.stringify(API_TOKEN)},configurable:true,writable:true,enumerable:false});` : ""}</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${bootScript}</head>`);
  }
  return `${bootScript}${html}`;
}

function resolveDistAssetPath(requestedPath: string): string | null {
  const normalizedPath = requestedPath.replace(/^\/+/, "");
  const segments = normalizedPath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const candidatePath = path.resolve(
      APP_DIST_DIR,
      segments.slice(index).join("/"),
    );
    if (
      candidatePath.startsWith(APP_DIST_DIR) &&
      existsSync(candidatePath) &&
      path.extname(candidatePath).length > 0
    ) {
      return candidatePath;
    }
  }
  return null;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function proxyUiRequest(args: {
  apiBase: string;
  request: IncomingMessage;
  response: ServerResponse<IncomingMessage>;
}): Promise<void> {
  const requestUrl = new URL(args.request.url ?? "/", "http://127.0.0.1");

  if (requestUrl.pathname.startsWith("/api/")) {
    const body = await readRequestBody(args.request);
    const headers: Record<string, string> = {};
    const contentType = args.request.headers["content-type"];
    if (typeof contentType === "string") {
      headers["content-type"] = contentType;
    }
    const authorization = args.request.headers.authorization;
    if (typeof authorization === "string") {
      headers.authorization = authorization;
    }

    const upstream = await fetch(
      `${args.apiBase}${requestUrl.pathname}${requestUrl.search}`,
      {
        body: body.byteLength > 0 ? body : undefined,
        headers,
        method: args.request.method ?? "GET",
      },
    );

    const proxyHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === "transfer-encoding") {
        return;
      }
      proxyHeaders[key] = value;
    });

    args.response.writeHead(upstream.status, proxyHeaders);
    args.response.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }

  const requestedPath =
    requestUrl.pathname === "/"
      ? "index.html"
      : requestUrl.pathname.replace(/^\/+/, "");
  let filePath = resolveDistAssetPath(requestedPath);
  const isAssetRequest = path.extname(requestedPath).length > 0;
  if (!filePath && !isAssetRequest) {
    filePath = path.join(APP_DIST_DIR, "index.html");
  }

  let body: Buffer;
  try {
    body = await fs.readFile(filePath ?? path.join(APP_DIST_DIR, "index.html"));
  } catch {
    body = await fs.readFile(path.join(APP_DIST_DIR, "index.html"));
    filePath = path.join(APP_DIST_DIR, "index.html");
  }

  if (
    path.basename(filePath ?? path.join(APP_DIST_DIR, "index.html")) ===
    "index.html"
  ) {
    body = Buffer.from(
      injectQaBootScript(body.toString("utf8"), args.apiBase),
      "utf8",
    );
  }

  args.response.writeHead(200, {
    "Content-Type": contentTypeFor(
      filePath ?? path.join(APP_DIST_DIR, "index.html"),
    ),
  });
  args.response.end(body);
}

function relayWebSocket(args: {
  apiBase: string;
  request: IncomingMessage;
  clientSocket: WebSocket;
}): void {
  const requestUrl = new URL(args.request.url ?? "/ws", "http://127.0.0.1");
  const upstreamUrl = new URL(args.apiBase);
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
  upstreamUrl.pathname = requestUrl.pathname;
  upstreamUrl.search = requestUrl.search;

  const upstreamSocket = new WebSocket(upstreamUrl, {
    headers:
      typeof args.request.headers.authorization === "string"
        ? { authorization: args.request.headers.authorization }
        : undefined,
  });

  const pendingClientMessages: Array<{
    data: Parameters<WebSocket["send"]>[0];
    isBinary: boolean;
  }> = [];

  const closeSocket = (socket: WebSocket) => {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  };

  args.clientSocket.on("message", (data, isBinary) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
      return;
    }
    if (upstreamSocket.readyState === WebSocket.CONNECTING) {
      pendingClientMessages.push({ data, isBinary });
    }
  });

  upstreamSocket.on("open", () => {
    for (const message of pendingClientMessages.splice(0)) {
      upstreamSocket.send(message.data, { binary: message.isBinary });
    }
  });

  upstreamSocket.on("message", (data, isBinary) => {
    if (args.clientSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    args.clientSocket.send(data, { binary: isBinary });
  });

  args.clientSocket.on("close", () => {
    closeSocket(upstreamSocket);
  });
  upstreamSocket.on("close", () => {
    closeSocket(args.clientSocket);
  });

  args.clientSocket.on("error", () => {
    closeSocket(upstreamSocket);
  });
  upstreamSocket.on("error", () => {
    closeSocket(args.clientSocket);
  });
}

async function startUiProxyServer(args: {
  apiBase: string;
  port: number;
}): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      await proxyUiRequest({
        apiBase: args.apiBase,
        request,
        response,
      });
    } catch (error) {
      console.error("[qa-checklist e2e] proxy error:", error);
      response.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "Internal proxy error" }));
    }
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (clientSocket) => {
      relayWebSocket({
        apiBase: args.apiBase,
        request,
        clientSocket,
      });
    });
  });
  server.on("close", () => {
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", () => resolve());
  });
  return server;
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode != null) {
    return true;
  }

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const handleExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
      child.off("close", handleExit);
    };

    child.once("exit", handleExit);
    child.once("close", handleExit);
  });
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${url}`);
  }
  return (await response.json()) as T;
}

async function waitForJson<T>(
  url: string,
  timeoutMs: number = STACK_READY_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return await fetchJson<T>(url);
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

async function startRealStack(): Promise<StartedStack> {
  await ensureUiDistReady();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-qa-live-"));
  const apiPort = await getFreePort();
  const uiPort = await getFreePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  const apiChild = spawn(
    "node",
    [
      path.join(REPO_ROOT, "eliza/packages/app-core/scripts/run-node-tsx.mjs"),
      path.join(REPO_ROOT, "eliza/packages/app-core/src/runtime/eliza.ts"),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ALLOW_NO_DATABASE: "",
        FORCE_COLOR: "0",
        ELIZA_API_PORT: String(apiPort),
        ELIZA_PORT: String(apiPort),
        ELIZA_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  apiChild.stdout.on("data", (chunk) => {
    process.stdout.write(`[live-qa][api] ${chunk}`);
  });
  apiChild.stderr.on("data", (chunk) => {
    process.stdout.write(`[live-qa][api-err] ${chunk}`);
  });

  const onboardingStatus = await waitForJson<{ complete: boolean }>(
    `${apiBase}/api/onboarding/status`,
  );
  if (onboardingStatus.complete) {
    throw new Error("Fresh live QA stack unexpectedly started complete");
  }

  const uiServer = await startUiProxyServer({
    apiBase,
    port: uiPort,
  });

  process.env.ELIZA_API_PORT = String(apiPort);

  return {
    apiBase,
    apiChild,
    stateDir,
    uiBase: `http://127.0.0.1:${uiPort}`,
    uiServer,
  };
}

async function restartLiveStack(): Promise<void> {
  if (!liveStack) {
    throw new Error("Cannot restart QA live stack before it exists");
  }

  console.log("[live-qa][setup] restart live stack: stop current");
  await stopRealStack(liveStack);
  console.log("[live-qa][setup] restart live stack: start new");
  liveStack = await startRealStack();
  API_URL = stripTrailingSlash(liveStack.apiBase);
  UI_URL = stripTrailingSlash(liveStack.uiBase);
  console.log(
    `[live-qa][setup] restart live stack: ready ui=${UI_URL} api=${API_URL}`,
  );
}

async function stopRealStack(stack: StartedStack | null): Promise<void> {
  if (!stack) return;

  try {
    await new Promise<void>((resolve, reject) =>
      stack.uiServer.close((error) => (error ? reject(error) : resolve())),
    );
  } catch {
    // Best effort during cleanup.
  }

  if (stack.apiChild.exitCode == null) {
    stack.apiChild.kill("SIGTERM");
    const exitedAfterTerm = await waitForChildExit(stack.apiChild, 5_000);
    if (!exitedAfterTerm && stack.apiChild.exitCode == null) {
      stack.apiChild.kill("SIGKILL");
      await waitForChildExit(stack.apiChild, 5_000);
    }
  }

  await fs.rm(stack.stateDir, { force: true, recursive: true });
}

async function ensureUiDistReady(): Promise<void> {
  const distIndex = path.join(APP_DIST_DIR, "index.html");
  try {
    await fs.access(distIndex);
    return;
  } catch {
    // Build the renderer bundle when this checkout only has partial assets.
  }

  const logs: string[] = [];
  const child = spawn("bun", ["scripts/build.mjs"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const exited = await waitForChildExit(child, 300_000);
  if (!exited || child.exitCode !== 0) {
    throw new Error(
      `packages/app renderer build failed.\n${logs.join("").slice(-8_000)}`,
    );
  }
}

async function smokeTabs(page: Page, profile: Profile) {
  const tabChecks: Array<{
    path: string;
    name: string;
    waitForReady: () => Promise<void>;
  }> = [
    {
      path: "/chat",
      name: "chat",
      waitForReady: () =>
        page.waitForSelector('[data-testid="chat-messages-scroll"]'),
    },
    {
      path: "/stream",
      name: "stream",
      waitForReady: () => page.waitForSelector("[data-stream-view]"),
    },
    {
      path: "/wallets",
      name: "wallets",
      waitForReady: () =>
        page.waitForSelector('[data-testid="wallet-rpc-popup"]'),
    },
    {
      path: "/connectors",
      name: "connectors",
      waitForReady: () =>
        Promise.any([
          page.waitForSelector('[data-testid="connectors-settings-content"]'),
          waitForAnyText(
            page,
            ["CONNECTORS", "Connectors", "Search connectors"],
            30_000,
          ),
        ]).then(() => undefined),
    },
    {
      path: "/settings",
      name: "settings",
      waitForReady: () =>
        page.waitForSelector('[data-testid="settings-shell"]'),
    },
    {
      path: "/triggers",
      name: "triggers",
      waitForReady: () =>
        waitForAnyText(
          page,
          ["New Task", "Automations", "Scheduled Task"],
          30_000,
        ),
    },
    {
      path: "/plugins",
      name: "plugins",
      waitForReady: () => waitForText(page, "AI PROVIDERS", 30_000),
    },
    {
      path: "/skills",
      name: "skills",
      waitForReady: () =>
        waitForAnyText(
          page,
          ["Create Skill", "No Skills Installed", "Skills"],
          30_000,
        ),
    },
    {
      path: "/runtime",
      name: "runtime",
      waitForReady: () => page.waitForSelector('[data-testid="runtime-view"]'),
    },
    {
      path: "/database",
      name: "database",
      waitForReady: () =>
        waitForAnyText(page, ["Tables", "Table Editor", "SQL Editor"], 30_000),
    },
    {
      path: "/desktop",
      name: "desktop",
      waitForReady: () =>
        waitForAnyText(
          page,
          [
            "Refresh Diagnostics",
            "Desktop workspace tools are only available inside the Electrobun desktop runtime.",
          ],
          30_000,
        ),
    },
    {
      path: "/logs",
      name: "logs",
      waitForReady: () =>
        waitForAnyText(
          page,
          ["Filter Logs", "No Log Entries Yet", "No log entries yet"],
          30_000,
        ),
    },
  ];

  const effectiveTabChecks =
    profile.id === "mobile"
      ? tabChecks.filter((tab) =>
          ["chat", "stream", "wallets", "connectors"].includes(tab.name),
        )
      : tabChecks;

  for (const tab of effectiveTabChecks) {
    logQaStep(profile, `smoke tab ${tab.name}`);
    await navigate(page, `${UI_URL}${tab.path}`);
    await tab.waitForReady();
    await saveScreenshot(page, profile, `tab-${tab.name}`);
  }
}

async function qaWalletRpcRoundtrip(page: Page, profile: Profile) {
  const expectedSelections = {
    evm: "infura",
    bsc: "nodereal",
    solana: "helius-birdeye",
  } as const;

  await navigate(page, `${UI_URL}/wallets`);
  await waitForText(page, "Tokens", 30_000);
  await openWalletRpcSettings(page, profile);
  await waitForText(page, "Custom RPC", 30_000);
  await clickByText(page, "Custom RPC");
  await waitForText(page, "Custom RPC Providers", 30_000);
  await clickByText(page, "Testnet");
  await clickByText(page, "Infura");
  await clickByText(page, "NodeReal");
  await clickByText(page, "Helius + Birdeye");
  await clickByText(page, "Save");

  const savedConfig = await waitFor(
    async () => {
      const config = await apiJson<{
        selectedRpcProviders?: {
          evm?: string | null;
          bsc?: string | null;
          solana?: string | null;
        };
        walletNetwork?: string | null;
      }>("/api/wallet/config");

      if (
        config.walletNetwork !== "testnet" ||
        config.selectedRpcProviders?.evm !== expectedSelections.evm ||
        config.selectedRpcProviders?.bsc !== expectedSelections.bsc ||
        config.selectedRpcProviders?.solana !== expectedSelections.solana
      ) {
        return null;
      }

      return config;
    },
    45_000,
    1000,
  );

  expect(savedConfig.walletNetwork).toBe("testnet");
  expect(savedConfig.selectedRpcProviders).toMatchObject(expectedSelections);

  await navigate(page, `${UI_URL}/chat`);
  await page.waitForSelector('[data-testid="chat-messages-scroll"]');
  await navigate(page, `${UI_URL}/wallets`);
  await waitForText(page, "Tokens", 30_000);
  await openWalletRpcSettings(page, profile);
  await waitForText(page, "Custom RPC Providers", 30_000);
  await waitForText(page, "Infura API Key", 30_000);
  await waitForText(page, "NodeReal BSC RPC URL", 30_000);
  await waitForText(page, "Helius API Key", 30_000);
  await waitForText(page, "Birdeye API Key", 30_000);
  await saveScreenshot(page, profile, "wallet-rpc-roundtrip");
}

async function installQaInstrumentation(page: Page) {
  await page.evaluateOnNewDocument(() => {
    type QaRegistryEngine = {
      playEmote?: (...args: unknown[]) => unknown;
      __qaPlayEmoteWrapped?: boolean;
    };

    type QaRegistryEntry = {
      engine?: QaRegistryEngine;
      role?: string;
      vrmPath?: string;
    };

    const qaWindow = window as typeof window & {
      __qaAudioStarts?: Array<{ at: number }>;
      __qaEmoteEvents?: QaEmoteEventRecord[];
      __qaFetches?: QaFetchRecord[];
      __qaPlayEmoteCalls?: QaPlayEmoteRecord[];
      __qaSpeechCalls?: Array<{ text: string; at: number }>;
      __qaTeleportEvents?: QaTeleportRecord[];
    };

    qaWindow.__qaAudioStarts = [];
    qaWindow.__qaEmoteEvents = [];
    qaWindow.__qaFetches = [];
    qaWindow.__qaPlayEmoteCalls = [];
    qaWindow.__qaSpeechCalls = [];
    qaWindow.__qaTeleportEvents = [];

    const QA_EMOTE_EVENT_NAME = "eliza:app-emote";
    const QA_TELEPORT_EVENT_NAME = "eliza:vrm-teleport-complete";
    let vrmRegistryStore: QaRegistryEntry[] = [];

    const recordWindowEvent = (event: Event) => {
      if (event.type === QA_EMOTE_EVENT_NAME) {
        const detail =
          event instanceof CustomEvent && typeof event.detail === "object"
            ? (event.detail as Record<string, unknown> | null)
            : null;
        qaWindow.__qaEmoteEvents?.push({
          type: event.type,
          emoteId: typeof detail?.emoteId === "string" ? detail.emoteId : null,
          path: typeof detail?.path === "string" ? detail.path : null,
          duration:
            typeof detail?.duration === "number" &&
            Number.isFinite(detail.duration)
              ? detail.duration
              : null,
          loop: typeof detail?.loop === "boolean" ? detail.loop : null,
          at: Date.now(),
        });
      }
      if (event.type === QA_TELEPORT_EVENT_NAME) {
        qaWindow.__qaTeleportEvents?.push({
          type: event.type,
          at: Date.now(),
        });
      }
    };

    const originalDispatchEvent = window.dispatchEvent.bind(window);
    window.dispatchEvent = (event: Event) => {
      recordWindowEvent(event);
      return originalDispatchEvent(event);
    };

    const patchRegistryEntry = (entry: QaRegistryEntry) => {
      const engine = entry.engine;
      if (!engine || typeof engine.playEmote !== "function") {
        return;
      }
      if (engine.__qaPlayEmoteWrapped === true) {
        return;
      }
      const originalPlayEmote = engine.playEmote.bind(engine);
      engine.playEmote = (...args: unknown[]) => {
        qaWindow.__qaPlayEmoteCalls?.push({
          role: typeof entry.role === "string" ? entry.role : null,
          vrmPath: typeof entry.vrmPath === "string" ? entry.vrmPath : null,
          path: typeof args[0] === "string" ? args[0] : null,
          duration:
            typeof args[1] === "number" && Number.isFinite(args[1])
              ? args[1]
              : null,
          loop: typeof args[2] === "boolean" ? args[2] : null,
          at: Date.now(),
        });
        return originalPlayEmote(...args);
      };
      engine.__qaPlayEmoteWrapped = true;
    };

    Object.defineProperty(window, "__ELIZA_VRM_ENGINES__", {
      configurable: true,
      get() {
        return vrmRegistryStore;
      },
      set(value) {
        vrmRegistryStore = Array.isArray(value) ? value : [];
        vrmRegistryStore.forEach((entry) => {
          patchRegistryEntry(entry);
        });
      },
    });

    const OriginalAudioContext =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (OriginalAudioContext) {
      const originalCreateBufferSource =
        OriginalAudioContext.prototype.createBufferSource;
      OriginalAudioContext.prototype.createBufferSource = function patched() {
        const source = originalCreateBufferSource.call(this);
        const originalStart = source.start.bind(source);
        source.start = (
          ...args: Parameters<AudioBufferSourceNode["start"]>
        ) => {
          qaWindow.__qaAudioStarts?.push({ at: Date.now() });
          return originalStart(...args);
        };
        return source;
      };
    }

    if (window.speechSynthesis?.speak) {
      const originalSpeak = window.speechSynthesis.speak.bind(
        window.speechSynthesis,
      );
      window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => {
        qaWindow.__qaSpeechCalls?.push({
          text: utterance.text,
          at: Date.now(),
        });
        return originalSpeak(utterance);
      };
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1];
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method ||
        (input instanceof Request ? input.method : undefined) ||
        "GET";

      try {
        const response = await originalFetch(...args);
        qaWindow.__qaFetches?.push({
          url: requestUrl,
          method: method.toUpperCase(),
          status: response.status,
        });
        return response;
      } catch (error) {
        qaWindow.__qaFetches?.push({
          url: requestUrl,
          method: method.toUpperCase(),
          error: String(error),
        });
        throw error;
      }
    };
  });
}

async function qaVoiceStats(page: Page): Promise<QaVoiceStats> {
  return page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __qaAudioStarts?: Array<{ at: number }>;
      __qaSpeechCalls?: Array<{ text: string; at: number }>;
      __qaFetches?: QaFetchRecord[];
    };

    const ttsFetches = (qaWindow.__qaFetches ?? []).filter((record) => {
      const url = String(record.url ?? "");
      let host = "";
      try {
        host = new URL(url, "http://localhost").hostname;
      } catch {
        host = "";
      }
      return (
        url.includes("/api/tts/") ||
        url.includes("/api/stream/voice/speak") ||
        host === "api.elevenlabs.io" ||
        host.endsWith(".elevenlabs.io")
      );
    });

    return {
      audioStarts: qaWindow.__qaAudioStarts?.length ?? 0,
      speechCalls: qaWindow.__qaSpeechCalls?.length ?? 0,
      ttsFetches,
    };
  });
}

async function qaFetches(page: Page): Promise<QaFetchRecord[]> {
  return page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __qaFetches?: QaFetchRecord[];
    };
    return qaWindow.__qaFetches ?? [];
  });
}

async function qaRemoteSnapshot(page: Page): Promise<QaRemoteSnapshot> {
  return page.evaluate(() => {
    const remoteApiBase = (
      document.querySelector<HTMLInputElement>("#remote-api-base")?.value ?? ""
    ).trim();
    const remoteTokenLength =
      document.querySelector<HTMLInputElement>("#remote-api-token")?.value
        .length ?? 0;
    const remoteError =
      document
        .querySelector("[role='alert'], [aria-live='assertive']")
        ?.textContent?.trim() ?? null;
    const connectButtonText =
      Array.from(
        document.querySelectorAll<HTMLElement>("button,[role='button']"),
      )
        .find((element) =>
          (element.innerText ?? "")
            .toLowerCase()
            .includes("connect remote backend"),
        )
        ?.innerText?.trim() ?? null;
    const body = document.body;
    const visibleText = body?.innerText ?? "";
    const domText = body?.textContent ?? "";
    return {
      activeServer: window.localStorage.getItem("eliza:active-server"),
      bodyText: `${visibleText}\n${domText}`,
      connectButtonText,
      remoteApiBase,
      remoteError,
      remoteTokenLength,
    };
  });
}

async function waitForVoicePlayback(
  page: Page,
  baseline: QaVoiceStats,
  timeout = 45_000,
): Promise<QaVoiceStats> {
  return waitFor(async () => {
    const stats = await qaVoiceStats(page);
    const newTtsFetches = stats.ttsFetches.slice(baseline.ttsFetches.length);
    const hasSuccessfulTts = newTtsFetches.some(
      (record) => record.status === 200,
    );
    const hasAudiblePlayback =
      stats.audioStarts > baseline.audioStarts ||
      stats.speechCalls > baseline.speechCalls;
    return hasSuccessfulTts || hasAudiblePlayback ? stats : null;
  }, timeout);
}

async function maybeWaitForVoicePlayback(
  page: Page,
  baseline: QaVoiceStats,
  timeout = 45_000,
): Promise<QaVoiceStats> {
  if (!REQUIRE_STRICT_TTS_ASSERTIONS) {
    return await qaVoiceStats(page);
  }

  return await waitForVoicePlayback(page, baseline, timeout);
}

async function maybeWaitForOptionalVoicePlayback(
  page: Page,
  baseline: QaVoiceStats,
  timeout = 45_000,
): Promise<QaVoiceStats> {
  try {
    return await maybeWaitForVoicePlayback(page, baseline, timeout);
  } catch {
    return await qaVoiceStats(page);
  }
}

async function waitForText(page: Page, text: string, timeout = 45_000) {
  await waitFor(async () => {
    const bodyText = await page.evaluate(() => {
      const body = document.body;
      const visibleText = body?.innerText ?? "";
      const domText = body?.textContent ?? "";
      return `${visibleText}\n${domText}`;
    });
    return bodyText.toLowerCase().includes(text.toLowerCase()) ? true : null;
  }, timeout);
}

async function waitForAnyText(
  page: Page,
  texts: readonly string[],
  timeout = 45_000,
) {
  await waitFor(async () => {
    const bodyText = await page.evaluate(() => {
      const body = document.body;
      const visibleText = body?.innerText ?? "";
      const domText = body?.textContent ?? "";
      return `${visibleText}\n${domText}`.toLowerCase();
    });
    return texts.some((text) => bodyText.includes(text.toLowerCase()))
      ? true
      : null;
  }, timeout);
}

async function waitForOnboardingEntry(page: Page, timeout = 45_000) {
  const overlay = await page
    .waitForSelector('[data-testid="onboarding-ui-overlay"]', {
      visible: true,
      timeout,
    })
    .catch(() => null);
  if (overlay) {
    return;
  }

  await waitForAnyText(
    page,
    [
      "Choose your setup",
      "Create Local Agent",
      "Connect to Remote Agent",
      "Choose your AI provider",
    ],
    timeout,
  );
}

async function waitForCompanionReady(page: Page, timeout = 90_000) {
  await page.waitForSelector('[data-testid="companion-root"]', {
    visible: true,
    timeout,
  });
  await page.waitForSelector('[data-testid="companion-header-shell"]', {
    visible: true,
    timeout,
  });
  await page.waitForSelector('[data-testid="chat-composer-textarea"]', {
    visible: true,
    timeout,
  });
}

async function pageContainsText(page: Page, text: string): Promise<boolean> {
  const bodyText = await page.evaluate(() => {
    const body = document.body;
    const visibleText = body?.innerText ?? "";
    const domText = body?.textContent ?? "";
    return `${visibleText}\n${domText}`.toLowerCase();
  });
  return bodyText.includes(text.toLowerCase());
}

async function currentVrmRegistry(page: Page): Promise<QaVrmRegistryEntry[]> {
  return page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __ELIZA_VRM_ENGINES__?: Array<{
        role?: string;
        vrmPath?: string;
        worldUrl?: string | null;
        getDebugInfo?: () => {
          avatar?: {
            loaded?: boolean;
            ready?: boolean;
          };
          cameraProfile?: string;
        };
      }>;
    };

    return (qaWindow.__ELIZA_VRM_ENGINES__ ?? []).map((entry) => {
      const debug =
        typeof entry.getDebugInfo === "function" ? entry.getDebugInfo() : null;
      return {
        role: typeof entry.role === "string" ? entry.role : null,
        vrmPath: typeof entry.vrmPath === "string" ? entry.vrmPath : null,
        worldUrl:
          typeof entry.worldUrl === "string" || entry.worldUrl === null
            ? entry.worldUrl
            : null,
        avatarLoaded: debug?.avatar?.loaded === true,
        avatarReady: debug?.avatar?.ready === true,
        cameraProfile:
          typeof debug?.cameraProfile === "string" ? debug.cameraProfile : null,
      };
    });
  });
}

async function _waitForWorldStageAvatar(
  page: Page,
  expectedSlug?: string | null,
  timeout = 90_000,
): Promise<QaVrmRegistryEntry> {
  return waitFor(async () => {
    const entries = await currentVrmRegistry(page);
    const worldStage =
      entries.find((entry) => entry.role === "world-stage") ?? null;
    if (!worldStage) return null;
    if (!worldStage.avatarLoaded || !worldStage.avatarReady) return null;
    if (expectedSlug && assetSlug(worldStage.vrmPath) !== expectedSlug)
      return null;
    return worldStage;
  }, timeout);
}

async function qaEmoteEvents(page: Page): Promise<QaEmoteEventRecord[]> {
  return page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __qaEmoteEvents?: QaEmoteEventRecord[];
    };
    return qaWindow.__qaEmoteEvents ?? [];
  });
}

async function _qaPlayEmoteCalls(page: Page): Promise<QaPlayEmoteRecord[]> {
  return page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __qaPlayEmoteCalls?: QaPlayEmoteRecord[];
    };
    return qaWindow.__qaPlayEmoteCalls ?? [];
  });
}

async function _qaTeleportEvents(page: Page): Promise<QaTeleportRecord[]> {
  return page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __qaTeleportEvents?: QaTeleportRecord[];
    };
    return qaWindow.__qaTeleportEvents ?? [];
  });
}

async function waitForCharacterRoster(
  page: Page,
  timeout = 90_000,
): Promise<CharacterRosterState> {
  await page.waitForSelector('[data-testid="character-roster-grid"]', {
    visible: true,
    timeout,
  });
  await waitFor(async () => {
    const roster = await page.$$eval(
      '[data-testid^="character-preset-"]',
      (buttons) => {
        const visibleButtons = buttons.filter((button) => {
          const style = window.getComputedStyle(button);
          return style.display !== "none" && style.visibility !== "hidden";
        });
        const selected = visibleButtons.find(
          (button) => button.getAttribute("aria-pressed") === "true",
        );
        return visibleButtons.length > 0 && selected
          ? {
              count: visibleButtons.length,
              selectedTestId: selected.getAttribute("data-testid"),
            }
          : null;
      },
    );
    return roster?.count ? roster : null;
  }, timeout);

  return page.$$eval('[data-testid^="character-preset-"]', (buttons) => {
    const labels = buttons
      .map((button) => (button.textContent ?? "").trim())
      .filter(Boolean);
    const selected = buttons.find(
      (button) => button.getAttribute("aria-pressed") === "true",
    );

    return {
      labels,
      selectedLabel: selected?.textContent?.trim() || null,
      selectedTestId: selected?.getAttribute("data-testid") ?? null,
    };
  });
}

async function characterRosterEntries(
  page: Page,
): Promise<CharacterRosterEntryState[]> {
  return page.$$eval('[data-testid^="character-preset-"]', (buttons) => {
    return buttons.map((button) => {
      const image = button.querySelector("img");
      return {
        label: (button.textContent ?? "").trim(),
        testId: button.getAttribute("data-testid"),
        selected: button.getAttribute("aria-pressed") === "true",
        previewSrc:
          image?.getAttribute("src") ?? image?.getAttribute("data-src") ?? null,
      };
    });
  });
}

async function _selectedCharacterPreviewSrc(page: Page): Promise<string> {
  const previewSrc = await page.$eval(
    '[data-testid^="character-preset-"][aria-pressed="true"] img',
    (img) => img.getAttribute("src"),
  );
  if (!previewSrc) {
    throw new Error("Selected character preview src was empty.");
  }
  return previewSrc;
}

async function clickByText(page: Page, text: string) {
  await clickByTextWithin(page, text);
}

async function clickByTextWithin(page: Page, text: string, timeout = 45_000) {
  await page.waitForFunction(
    (expected) => {
      const normalizedExpected = String(expected).toLowerCase();
      return Array.from(
        document.querySelectorAll<HTMLElement>("button,[role='button']"),
      ).some((element) => {
        const position = window.getComputedStyle(element).position;
        const visible =
          element.offsetParent !== null ||
          position === "fixed" ||
          position === "sticky";
        const label = (element.innerText ?? "").toLowerCase();
        return visible && label.includes(normalizedExpected);
      });
    },
    { timeout },
    text,
  );

  const clicked = await page.evaluate((expected) => {
    const normalizedExpected = String(expected).toLowerCase();
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>("button,[role='button']"),
    );
    const target = elements.find((element) => {
      const position = window.getComputedStyle(element).position;
      const visible =
        element.offsetParent !== null ||
        position === "fixed" ||
        position === "sticky";
      const label = (element.innerText ?? "").toLowerCase();
      return visible && label.includes(normalizedExpected);
    });
    target?.click();
    return Boolean(target);
  }, text);
  expect(clicked).toBe(true);
}

async function clickAnyText(
  page: Page,
  texts: readonly string[],
  timeout = 45_000,
) {
  const deadline = Date.now() + timeout;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    for (const text of texts) {
      try {
        await clickByTextWithin(page, text, 2_500);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    await page.waitForTimeout(250);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not click any of: ${texts.join(", ")}`);
}

async function clickButtonLabel(page: Page, label: string, timeout = 45_000) {
  const normalizedLabel = label.trim().toLowerCase();
  await page.waitForFunction(
    (expected) => {
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>("button,[role='button']"),
      );
      return elements.some((element) => {
        const position = window.getComputedStyle(element).position;
        const visible =
          element.offsetParent !== null ||
          position === "fixed" ||
          position === "sticky";
        const text = (element.innerText ?? "").trim().toLowerCase();
        return visible && text === expected;
      });
    },
    { timeout },
    normalizedLabel,
  );

  const clicked = await page.evaluate((expected) => {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>("button,[role='button']"),
    );
    const target = elements.find((element) => {
      const position = window.getComputedStyle(element).position;
      const visible =
        element.offsetParent !== null ||
        position === "fixed" ||
        position === "sticky";
      const text = (element.innerText ?? "").trim().toLowerCase();
      return visible && text === expected;
    });
    target?.click();
    return Boolean(target);
  }, normalizedLabel);

  expect(clicked).toBe(true);
}

async function openWalletRpcSettings(page: Page, profile: Profile) {
  if (profile.id === "mobile") {
    const openedDrawer = await page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>("button,[role='button']"),
      );
      const target = elements.find((element) => {
        const position = window.getComputedStyle(element).position;
        const visible =
          element.offsetParent !== null ||
          position === "fixed" ||
          position === "sticky";
        const text = (element.innerText ?? "").trim().toLowerCase();
        return visible && text === "browse";
      });
      target?.click();
      return Boolean(target);
    });

    if (openedDrawer) {
      try {
        await clickSelector(page, '[data-testid="wallet-rpc-popup"]');
        return;
      } catch {
        // Drawer state can lag the DOM; fall back to the mounted trigger below.
      }
    }
  }

  await clickSelector(page, '[data-testid="wallet-rpc-popup"]', {
    allowHidden: profile.id === "mobile",
  });
}

async function clickSelector(
  page: Page,
  selector: string,
  options: { allowHidden?: boolean } = {},
) {
  if (options.allowHidden) {
    await page.waitForSelector(selector, { timeout: 45_000 });
  } else {
    await page.waitForFunction(
      (expected) => {
        const element = document.querySelector(expected);
        if (!(element instanceof HTMLElement)) return false;
        const position = window.getComputedStyle(element).position;
        return (
          element.offsetParent !== null ||
          position === "fixed" ||
          position === "sticky"
        );
      },
      { timeout: 45_000 },
      selector,
    );
  }
  const clicked = await page.evaluate((expected) => {
    const element = document.querySelector(expected);
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return true;
  }, selector);
  expect(clicked).toBe(true);
}

async function typeInto(page: Page, selector: string, value: string) {
  const input = await page.waitForSelector(selector, { visible: true });
  expect(input).toBeTruthy();
  if (!input) {
    throw new Error(`Input not found for selector: ${selector}`);
  }
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await input.type(value, { delay: 5 });
}

async function isSelectorVisible(
  page: Page,
  selector: string,
): Promise<boolean> {
  return await page
    .$eval(selector, (element) => {
      const htmlElement = element instanceof HTMLElement ? element : null;
      if (!htmlElement) {
        return false;
      }

      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    })
    .catch(() => false);
}

async function typeComposerAndSend(page: Page, value: string) {
  await typeInto(page, '[data-testid="chat-composer-textarea"]', value);
  await page.keyboard.press("Enter");
}

async function completeLocalProviderOnboarding(page: Page) {
  if (!LIVE_PROVIDER || !LIVE_PROVIDER_LABEL) {
    throw new Error("A live LLM provider is required for QA onboarding.");
  }

  await waitForOnboardingEntry(page, 180_000);

  if (await pageContainsText(page, "Choose your setup")) {
    if (await pageContainsText(page, "Create Local Agent")) {
      await clickAnyText(page, ["Create Local Agent"]);
    } else {
      await clickAnyText(page, ["Connect to Remote Agent"]);
      await page.waitForSelector(
        'input[placeholder*="your-agent.example.com"]',
        {
          visible: true,
          timeout: 30_000,
        },
      );
      await typeInto(
        page,
        'input[placeholder*="your-agent.example.com"]',
        UI_URL,
      );
      await clickButtonLabel(page, "Connect");

      const connectionRemoteApiBase = await page
        .waitForSelector("#remote-api-base", {
          visible: true,
          timeout: 30_000,
        })
        .catch(() => null);
      if (connectionRemoteApiBase) {
        await typeInto(page, "#remote-api-base", UI_URL);
        await clickButtonLabel(page, "Connect remote backend");
        await waitFor(async () => {
          const remote = await qaRemoteSnapshot(page);
          if (remote.remoteError) {
            throw new Error(
              `Remote backend connect failed: ${remote.remoteError}`,
            );
          }
          const bodyText = remote.bodyText.toLowerCase();
          return bodyText.includes("choose your ai provider") ||
            bodyText.includes("groq")
            ? true
            : null;
        }, 60_000);
      }
    }
  } else {
    if (await pageContainsText(page, "Create Local Agent")) {
      await clickAnyText(page, ["Create Local Agent"]);
    } else {
      await clickAnyText(page, ["Get Started"]);
    }
  }

  const alreadyOnProviderGrid =
    (await pageContainsText(page, "Choose your AI provider")) ||
    (await pageContainsText(page, LIVE_PROVIDER_LABEL));

  if (!alreadyOnProviderGrid) {
    await waitForAnyText(page, ["Continue", "Eliza"], 60_000);
    await clickAnyText(page, ["Continue"]);
  }
  await waitForAnyText(
    page,
    ["Choose your AI provider", LIVE_PROVIDER_LABEL],
    60_000,
  );
  await clickAnyText(page, [LIVE_PROVIDER_LABEL]);

  const providerApiKeyInput = await page
    .waitForSelector("#provider-api-key", {
      visible: true,
      timeout: 2_500,
    })
    .catch(() => null);

  if (providerApiKeyInput) {
    await typeInto(page, "#provider-api-key", LIVE_PROVIDER.apiKey);
  } else {
    await typeInto(page, 'input[type="password"]', LIVE_PROVIDER.apiKey);
  }

  await clickAnyText(page, ["Confirm"]);
  await waitForAnyText(page, ["Enable features", "Skip for now"], 60_000);
  await clickAnyText(page, ["Skip for now", "Continue without features"]);
  await waitFor(async () => (await onboardingComplete()) || null, 120_000);
}

async function enterCompanionMode(page: Page) {
  try {
    await clickSelector(page, '[data-testid="ui-shell-toggle-companion"]');
  } catch {
    await navigate(page, `${UI_URL}/apps/companion`);
  }
  await page.waitForFunction(
    () => {
      return (
        window.location.pathname.endsWith("/apps/companion") &&
        Boolean(document.querySelector('[data-testid="companion-root"]')) &&
        Boolean(
          document.querySelector('[data-testid="companion-header-shell"]'),
        )
      );
    },
    { timeout: 30_000 },
  );
}

async function qaCharacterSwitchAndDance(page: Page, profile?: Profile) {
  if (profile) {
    logQaStep(profile, "character-switch QA open companion character view");
  }
  await enterCompanionMode(page);
  await clickSelector(page, '[data-testid="companion-shell-toggle-character"]');
  const roster = await waitForCharacterRoster(page, 120_000);
  const entries = await characterRosterEntries(page);
  const currentEntry = entries.find((entry) => entry.selected);
  expect(currentEntry?.testId).toBe(roster.selectedTestId);

  const nextEntry = entries.find(
    (entry) => entry.testId && entry.testId !== roster.selectedTestId,
  );
  if (!nextEntry?.testId) {
    throw new Error(
      "No alternate character entry was available for switching.",
    );
  }

  if (profile) {
    logQaStep(profile, `character-switch QA select ${nextEntry.testId}`);
  }
  await clickSelector(page, `[data-testid="${nextEntry.testId}"]`);
  await page
    .waitForSelector(
      `[data-testid="${nextEntry.testId}"][aria-pressed="true"]`,
      {
        visible: true,
        timeout: 20_000,
      },
    )
    .catch(() => null);

  const danceFetchBaseline = (await qaFetches(page)).length;
  const danceEmoteBaseline = (await qaEmoteEvents(page)).length;

  if (profile) {
    logQaStep(profile, "character-switch QA open dance emote picker");
  }
  await page.evaluate(() => {
    document.dispatchEvent(new Event("eliza:emote-picker"));
  });
  await page.waitForSelector('button[title="Dance Happy"]', {
    visible: true,
    timeout: 30_000,
  });
  await clickSelector(page, 'button[title="Dance Happy"]');
  await waitFor(
    async () => {
      const overlayVisible = await page
        .waitForSelector(
          '[data-testid="global-emote-overlay"][data-emote-id="dance-happy"]',
          {
            visible: true,
            timeout: 1000,
          },
        )
        .then(() => true)
        .catch(() => false);
      if (overlayVisible) {
        return true;
      }

      const events = await qaEmoteEvents(page);
      return events
        .slice(danceEmoteBaseline)
        .some((event) => event.emoteId === "dance-happy")
        ? true
        : null;
    },
    45_000,
    1000,
  );

  if (profile) {
    logQaStep(profile, "character-switch QA wait for dance emote API");
  }
  const emoteFetches = await waitFor(async () => {
    const fetches = await qaFetches(page);
    const latest = fetches.slice(danceFetchBaseline);
    return latest.some(
      (record) =>
        record.method === "POST" &&
        String(record.url).includes("/api/emote") &&
        record.status === 200,
    )
      ? latest
      : null;
  }, 45_000);
  expect(
    emoteFetches.some(
      (record) =>
        record.method === "POST" &&
        String(record.url).includes("/api/emote") &&
        record.status === 200,
    ),
  ).toBe(true);

  if (profile) {
    logQaStep(profile, "character-switch QA wait for dance emote event");
  }
  const danceEvents = await waitFor(async () => {
    const events = await qaEmoteEvents(page);
    const latest = events.slice(danceEmoteBaseline);
    return latest.some((event) => event.emoteId === "dance-happy")
      ? latest
      : null;
  }, 45_000);
  expect(danceEvents.some((event) => event.emoteId === "dance-happy")).toBe(
    true,
  );
}

async function writeDocumentFile(profileId: string): Promise<string> {
  const filename = `eliza-qa-knowledge-${profileId}.txt`;
  const fullPath = path.join(os.tmpdir(), filename);
  await fs.writeFile(
    fullPath,
    [
      "Eliza QA knowledge fixture.",
      `The QA codeword is ${KNOWLEDGE_CODEWORD}.`,
      "If asked for the QA codeword, answer with only the codeword.",
    ].join("\n"),
    "utf8",
  );
  return fullPath;
}

async function onboardingComplete(): Promise<boolean> {
  const result = await apiJson<{ complete: boolean }>("/api/onboarding/status");
  return result.complete;
}

async function resetAgentViaApi() {
  if (liveStack) {
    console.log("[live-qa][setup] reset via live stack restart");
    await restartLiveStack();
    console.log("[live-qa][setup] reset via live stack restart complete");
    if (await onboardingComplete()) {
      throw new Error(
        "Fresh QA stack unexpectedly reported onboarding complete after restart.",
      );
    }
    return;
  }

  await apiJson("/api/agent/reset", { method: "POST" });
  await waitFor(async () => !(await onboardingComplete()), 30_000);
  const conversations = await listConversations();
  const documents = await listDocumentsAfterReset();
  if (conversations.length > 0 || documents.length > 0) {
    throw new Error(
      `Reset API left persisted state behind (conversations=${conversations.length}, documents=${documents.length}). Hard runtime restart required before live QA.`,
    );
  }
}

async function listConversations(): Promise<Array<{ id: string }>> {
  const result = await apiJson<{ conversations: Array<{ id: string }> }>(
    "/api/conversations",
  );
  return result.conversations ?? [];
}

async function listMessages(
  conversationId: string,
): Promise<Array<{ role: string; text: string }>> {
  const result = await apiJson<{
    messages: Array<{ role: string; text: string }>;
  }>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
  return result.messages ?? [];
}

async function listDocuments(): Promise<Array<{ filename: string }>> {
  const result = await apiJson<{ documents: Array<{ filename: string }> }>(
    "/api/documents",
  );
  return result.documents ?? [];
}

async function listDocumentsAfterReset(): Promise<
  Array<{ filename: string }>
> {
  try {
    return await listDocuments();
  } catch (error) {
    if (
      !(await onboardingComplete()) ||
      (error instanceof Error && /^(404|500)\b/.test(error.message))
    ) {
      return [];
    }
    throw error;
  }
}

async function documentSearch(
  query: string,
): Promise<Array<{ text: string }>> {
  const encoded = encodeURIComponent(query);
  const result = await apiJson<{ results: Array<{ text: string }> }>(
    `/api/documents/search?q=${encoded}&threshold=0.1&limit=5`,
  );
  return result.results ?? [];
}

async function apiJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const url = new URL(pathname, API_URL);
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  if (API_TOKEN) {
    headers.set("Authorization", `Bearer ${API_TOKEN}`);
  }
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${url.pathname}`,
    );
  }
  return (await response.json()) as T;
}

async function ensureHttpOk(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Expected ${url} to be reachable, got ${response.status}`);
  }
}

async function isHttpOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function _resolveLiveUiUrl(): Promise<string> {
  if (await isHttpOk(`${DEFAULT_UI_URL}/`)) {
    return DEFAULT_UI_URL;
  }

  const candidates: string[] = [];

  try {
    const stack = await apiJson<{
      desktop?: {
        rendererUrl?: string | null;
        uiPort?: number | null;
      };
      desktopDevLog?: {
        filePath?: string | null;
      };
    }>("/api/dev/stack");

    if (stack.desktop?.rendererUrl) {
      candidates.push(stripTrailingSlash(stack.desktop.rendererUrl));
    }

    if (typeof stack.desktop?.uiPort === "number" && stack.desktop.uiPort > 0) {
      candidates.push(`http://127.0.0.1:${stack.desktop.uiPort}`);
      candidates.push(`http://localhost:${stack.desktop.uiPort}`);
    }

    const devLogPath = stack.desktopDevLog?.filePath?.trim();
    if (devLogPath) {
      const logContent = await fs.readFile(devLogPath, "utf8");
      const rendererMatches = logContent.match(
        /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g,
      );
      if (rendererMatches) {
        candidates.push(...rendererMatches.map(stripTrailingSlash));
      }
    }
  } catch {
    // Fall back to static guesses below.
  }

  candidates.push("http://127.0.0.1:5174", "http://localhost:5174");

  const uniqueCandidates = [...new Set(candidates)];
  for (const candidate of uniqueCandidates) {
    if (await isHttpOk(`${candidate}/`)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to resolve live UI URL. Tried: ${[DEFAULT_UI_URL, ...uniqueCandidates].join(", ")}`,
  );
}

async function navigate(page: Page, url: string) {
  const targetUrl = new URL(url);
  const currentUrl = page.url();

  if (currentUrl) {
    const current = new URL(currentUrl);
    if (current.origin === targetUrl.origin) {
      await page.evaluate((nextHref) => {
        const next = new URL(nextHref, window.location.href);
        const nextPath = `${next.pathname}${next.search}${next.hash}`;
        const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (currentPath === nextPath) return;
        window.history.pushState({}, "", nextPath);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, targetUrl.href);

      await waitFor(
        async () => {
          const href = await page.evaluate(() => window.location.href);
          return href === targetUrl.href ? true : null;
        },
        30_000,
        100,
      );

      await page.waitForFunction(() => document.readyState !== "loading", {
        timeout: 30_000,
      });
      return;
    }
  }

  await page.goto(targetUrl.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.readyState !== "loading", {
    timeout: 30_000,
  });
}

async function saveScreenshot(page: Page, profile: Profile, step: string) {
  const filename = path.join(QA_ARTIFACT_DIR, `${profile.id}-${step}.png`);
  try {
    await page.screenshot({ path: filename, fullPage: true });
  } catch (error) {
    const noteFile = path.join(QA_ARTIFACT_DIR, `${profile.id}-${step}.txt`);
    await fs.writeFile(
      noteFile,
      `Screenshot unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      "utf8",
    );
  }
}

async function saveFailureArtifacts(
  page: Page,
  profile: Profile,
  error: unknown,
) {
  await saveScreenshot(page, profile, "failure");
  const textFile = path.join(
    QA_ARTIFACT_DIR,
    `${profile.id}-failure-state.txt`,
  );

  let url = "unavailable";
  let title = "unavailable";
  let bodyText = "unavailable";
  let fetchSummary = "unavailable";
  let remoteSummary = "unavailable";
  let voiceStatsSummary = "unavailable";

  try {
    url = page.url();
  } catch {}

  try {
    title = await page.title();
  } catch {}

  try {
    bodyText = await page.evaluate(() =>
      document.body.innerText.slice(0, 10_000),
    );
  } catch (pageError) {
    bodyText = `Unavailable: ${pageError instanceof Error ? pageError.message : String(pageError)}`;
  }

  try {
    const fetches = await qaFetches(page);
    fetchSummary = JSON.stringify(fetches.slice(-80), null, 2);
  } catch (fetchError) {
    fetchSummary = `Unavailable: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;
  }

  try {
    const remote = await qaRemoteSnapshot(page);
    remoteSummary = JSON.stringify(remote, null, 2);
  } catch (remoteError) {
    remoteSummary = `Unavailable: ${remoteError instanceof Error ? remoteError.message : String(remoteError)}`;
  }

  try {
    const voiceStats = await qaVoiceStats(page);
    voiceStatsSummary = JSON.stringify(voiceStats, null, 2);
  } catch (statsError) {
    voiceStatsSummary = `Unavailable: ${statsError instanceof Error ? statsError.message : String(statsError)}`;
  }

  await fs.writeFile(
    textFile,
    [
      `Error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      `URL: ${url}`,
      `Title: ${title}`,
      "",
      "Remote snapshot:",
      remoteSummary,
      "",
      "Recent fetches:",
      fetchSummary,
      "",
      "Voice stats:",
      voiceStatsSummary,
      "",
      bodyText,
    ].join("\n"),
    "utf8",
  );
}

async function waitFor<T>(
  producer: () => Promise<T | null | false> | T | null | false,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await producer();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out after ${timeoutMs}ms`);
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function expectValidGreetingMessage(value: string): void {
  const normalized = normalizeText(value);
  expect(normalized.length).toBeGreaterThan(2);
  expect(normalized).not.toContain("reply with exactly these two words");
  expect(normalized).not.toContain("qa codeword from the uploaded file");
}

function assetSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const pathname = value.startsWith("http") ? new URL(value).pathname : value;
    const filename = pathname.split("/").pop() ?? "";
    if (!filename) return null;
    return filename.replace(/\.vrm(\.gz)?$/i, "").replace(/\.png$/i, "");
  } catch {
    return null;
  }
}

function ensureBrowser(value: Browser | null): Browser {
  if (!value) {
    throw new Error("Browser was not started");
  }
  return value;
}
