// End-to-end Playwright spec for the chat sensitive-request widgets.
//
// Two scenarios covered:
//
//   1. Secret-form scenario — the assistant message carries a
//      `secretRequest.form.kind === "secret"`. Submitting the form posts the
//      raw value to `PUT /api/secrets` (`client.updateSecrets`), the status
//      flips to "Saved", and the secret value MUST NOT appear in the body of
//      any request to the chat-message endpoints.
//
//   2. OAuth scenario — the assistant message carries a
//      `secretRequest.form.kind === "oauth"` with a provider authorization
//      URL. Clicking the "Connect …" button opens the URL via `window.open`
//      with `noopener` + `noreferrer`, never substitutes the URL into chat
//      text, and never invokes `updateSecrets`.
//
// These are the security invariants captured in
// `plugins/plugin-agent-orchestrator/docs/orchestrator-dashboard-task-widget-secrets-assessment.md`
// (gap #3); the component tests already cover the rendering contract.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const CONVERSATION_ID = "sensitive-request-conversation";
const ROOM_ID = "sensitive-request-room";
const SECRET_KEY = "OPENAI_API_KEY";
const RAW_SECRET_VALUE = "sk-playwright-secret-value-do-not-leak";
const OAUTH_AUTHORIZATION_URL =
  "https://example.test/oauth/authorize?state=abc";
const OAUTH_URL_SUBSTRING = "example.test/oauth/authorize";
const EVIDENCE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
  "test-results/ui-smoke-artifacts/8907-credential-request",
);

type JsonRecord = Record<string, unknown>;

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

type ChatBackendHandles = {
  /** Raw bodies seen by EITHER chat-message POST endpoint (incl. /stream). */
  chatPostBodies: string[];
  /** Bodies received by the `PUT /api/secrets` (updateSecrets) endpoint. */
  secretsPutBodies: JsonRecord[];
  /** Bodies received by the tunnel-only credential endpoint. */
  credentialTunnelBodies: JsonRecord[];
};

async function installSensitiveRequestChatRoutes(
  page: Page,
  secretRequest: NonNullable<JsonRecord["secretRequest"]> | JsonRecord,
): Promise<ChatBackendHandles> {
  const conversation = {
    id: CONVERSATION_ID,
    roomId: ROOM_ID,
    title: "Sensitive request chat",
    updatedAt: NOW,
    createdAt: NOW,
  };
  const seedAssistantText = "I need a credential to continue.";
  const messages = [
    {
      id: "seed-user-1",
      role: "user" as const,
      text: "Connect my GitHub account.",
      source: "eliza",
      roomId: ROOM_ID,
      timestamp: NOW_MS - 5_000,
    },
    {
      id: "seed-assistant-1",
      role: "assistant" as const,
      text: seedAssistantText,
      source: "eliza",
      roomId: ROOM_ID,
      timestamp: NOW_MS - 2_000,
      secretRequest,
    },
  ];
  const chatPostBodies: string[] = [];
  const secretsPutBodies: JsonRecord[] = [];
  const credentialTunnelBodies: JsonRecord[] = [];

  await page.route("**/api/conversations**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
    if (route.request().method() === "GET") {
      await fulfillJson(route, { conversations: [conversation] });
      return;
    }
    if (route.request().method() === "POST") {
      await fulfillJson(route, { conversation });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/conversations/${CONVERSATION_ID}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await fulfillJson(route, { conversation });
      return;
    }
    if (route.request().method() === "GET") {
      await fulfillJson(route, { conversation });
      return;
    }
    await route.fallback();
  });

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages**`,
    async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await fulfillJson(route, { messages });
        return;
      }
      if (request.method() === "POST") {
        chatPostBodies.push(request.postData() ?? "");
        await fulfillJson(route, {
          text: "Acknowledged.",
          agentName: "Eliza",
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages/stream`,
    async (route) => {
      chatPostBodies.push(route.request().postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          type: "done",
          fullText: "Acknowledged.",
          agentName: "Eliza",
        })}\n\n`,
      });
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/greeting**`,
    async (route) => {
      await fulfillJson(route, { text: "Ready.", localInference: null });
    },
  );

  // `client.updateSecrets` PUTs to `/api/secrets` with body `{ secrets: {...} }`.
  await page.route("**/api/secrets", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const raw = request.postData() ?? "{}";
      const parsed = JSON.parse(raw) as { secrets?: JsonRecord };
      secretsPutBodies.push((parsed.secrets ?? {}) as JsonRecord);
      await fulfillJson(route, {
        ok: true,
        updated: Object.keys(parsed.secrets ?? {}),
      });
      return;
    }
    if (request.method() === "GET") {
      await fulfillJson(route, { secrets: [] });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/credential-tunnel", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const parsed = JSON.parse(request.postData() ?? "{}") as JsonRecord;
      credentialTunnelBodies.push(parsed);
      await fulfillJson(route, {
        ok: true,
        credentialScopeId: parsed.credentialScopeId,
        childSessionId: parsed.childSessionId,
        key: parsed.key,
      });
      return;
    }
    await route.fallback();
  });

  return { chatPostBodies, secretsPutBodies, credentialTunnelBodies };
}

/** Assert no chat-message body ever carried the raw secret substring. */
function assertSecretNeverLeakedToChat(
  bodies: readonly string[],
  needle: string,
): void {
  for (const body of bodies) {
    expect(
      body.includes(needle),
      `chat-message endpoint body unexpectedly contained the raw secret value: ${body.slice(0, 120)}`,
    ).toBe(false);
  }
}

async function writeEvidenceScreenshot(
  page: Page,
  fileName: string,
): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, fileName),
    fullPage: true,
  });
}

async function openChatSheet(page: Page): Promise<void> {
  const sheet = page.getByTestId("chat-sheet");
  if ((await sheet.getAttribute("data-variant")) === "open") {
    return;
  }
  const pill = page.getByTestId("chat-pill");
  if ((await pill.count()) > 0) {
    await pill.press("ArrowUp");
    if ((await sheet.getAttribute("data-variant")) === "open") {
      return;
    }
  }
  const grabber = page.getByTestId("chat-sheet-grabber");
  if ((await grabber.count()) === 0) {
    return;
  }
  await grabber.press("ArrowUp");
  await expect(sheet).toHaveAttribute("data-variant", "open", {
    timeout: 5_000,
  });
}

test.describe("chat sensitive request — secret form", () => {
  test("submits the secret value to updateSecrets only, never through the chat-message endpoint", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);

    const secretRequest = {
      key: SECRET_KEY,
      reason: "Provider setup",
      status: "pending",
      delivery: {
        mode: "inline_owner_app",
        instruction: "Enter it in this owner-only app form.",
        privateRouteRequired: true,
        canCollectValueInCurrentChannel: true,
      },
      form: {
        type: "sensitive_request_form",
        kind: "secret",
        mode: "inline_owner_app",
        fields: [
          {
            name: SECRET_KEY,
            label: SECRET_KEY,
            input: "secret",
            required: true,
          },
        ],
        submitLabel: "Save secret",
        statusOnly: true,
      },
    };
    const handles = await installSensitiveRequestChatRoutes(
      page,
      secretRequest,
    );

    await openAppPath(page, "/chat");
    await openChatSheet(page);

    const widget = page.getByTestId("sensitive-request").first();
    await expect(widget).toBeVisible({ timeout: 30_000 });
    const status = page.getByTestId("sensitive-request-status").first();
    await expect(status).toContainText("Pending");

    const input = page.getByLabel(SECRET_KEY).first();
    await expect(input).toHaveAttribute("type", "password");
    await input.fill(RAW_SECRET_VALUE);

    const submit = page.getByTestId("sensitive-request-submit").first();
    await submit.click();

    await expect.poll(() => handles.secretsPutBodies.length).toBe(1);
    const firstSecretPut = handles.secretsPutBodies[0] ?? {};
    expect(Object.keys(firstSecretPut)).toEqual([SECRET_KEY]);
    expect(firstSecretPut[SECRET_KEY]).toBe(RAW_SECRET_VALUE);

    // After updateSecrets succeeds, the widget flips to "Saved" and removes
    // the input from the DOM (the component test locks this in).
    await expect(status).toContainText("Saved", { timeout: 10_000 });
    await expect(page.getByLabel(SECRET_KEY)).toHaveCount(0);

    // The raw secret value must never appear in any chat-message body.
    assertSecretNeverLeakedToChat(handles.chatPostBodies, RAW_SECRET_VALUE);

    // Belt and suspenders: the rendered DOM also must not contain the raw value.
    const visibleText = (await page.locator("body").textContent()) ?? "";
    expect(visibleText.includes(RAW_SECRET_VALUE)).toBe(false);
  });
});

test.describe("chat sensitive request — sub-agent credential tunnel", () => {
  test("submits credentials only to the tunnel endpoint and captures desktop/mobile evidence", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);

    const secretRequest = {
      key: "SUB_AGENT_CREDENTIALS",
      reason: "A child coding agent needs credentials to continue.",
      status: "pending",
      delivery: {
        mode: "inline_owner_app",
        instruction: "Enter it in this owner-only app form.",
        privateRouteRequired: true,
        canCollectValueInCurrentChannel: true,
        tunnel: {
          childSessionId: "pty-1-abc",
          credentialScopeId: "cred_scope_test",
          keys: ["OPENAI_API_KEY", "STRIPE_API_KEY"],
        },
      },
      form: {
        type: "sensitive_request_form",
        kind: "secret",
        mode: "inline_owner_app",
        fields: [
          {
            name: "OPENAI_API_KEY",
            label: "OPENAI_API_KEY",
            input: "secret",
            required: true,
          },
          {
            name: "STRIPE_API_KEY",
            label: "STRIPE_API_KEY",
            input: "secret",
            required: true,
          },
        ],
        submitLabel: "Send to sub-agent",
        statusOnly: true,
      },
    };
    const handles = await installSensitiveRequestChatRoutes(
      page,
      secretRequest,
    );

    await openAppPath(page, "/chat");
    await openChatSheet(page);

    const widget = page.getByTestId("sensitive-request").first();
    await expect(widget).toBeVisible({ timeout: 30_000 });
    await widget.scrollIntoViewIfNeeded();
    await writeEvidenceScreenshot(page, "8907-sensitive-request-desktop.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await openChatSheet(page);
    await expect(widget).toBeVisible();
    await widget.scrollIntoViewIfNeeded();
    await writeEvidenceScreenshot(page, "8907-sensitive-request-mobile.png");

    await page.getByLabel("OPENAI_API_KEY").fill(RAW_SECRET_VALUE);
    await page
      .getByLabel("STRIPE_API_KEY")
      .fill("sk-stripe-playwright-secret-value-do-not-leak");
    await page.getByTestId("sensitive-request-submit").click();

    await expect.poll(() => handles.credentialTunnelBodies.length).toBe(2);
    expect(handles.secretsPutBodies).toHaveLength(0);
    expect(handles.credentialTunnelBodies.map((body) => body.key)).toEqual([
      "OPENAI_API_KEY",
      "STRIPE_API_KEY",
    ]);
    expect(handles.credentialTunnelBodies[0]?.value).toBe(RAW_SECRET_VALUE);

    assertSecretNeverLeakedToChat(handles.chatPostBodies, RAW_SECRET_VALUE);
    const visibleText = (await page.locator("body").textContent()) ?? "";
    expect(visibleText.includes(RAW_SECRET_VALUE)).toBe(false);
  });
});

test.describe("chat sensitive request — OAuth", () => {
  test("opens the authorization URL in a popup with noopener+noreferrer and never substitutes the URL into chat", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);

    // Hijack `window.open` BEFORE any app code runs so the click captures
    // arguments without actually opening a popup. We also stub it to return a
    // truthy window-like object so the widget treats the open as successful
    // (component contract: a truthy return → button flips to "Authorizing…").
    await page.addInitScript(() => {
      const win = window as unknown as {
        __sensitiveOauthOpenCalls: Array<{
          url: string;
          target: string;
          features: string;
        }>;
        __sensitiveOauthOpenerNulled?: () => boolean;
        open: typeof window.open;
      };
      win.__sensitiveOauthOpenCalls = [];
      win.open = ((url?: string | URL, target?: string, features?: string) => {
        win.__sensitiveOauthOpenCalls.push({
          url: typeof url === "string" ? url : String(url ?? ""),
          target: typeof target === "string" ? target : "",
          features: typeof features === "string" ? features : "",
        });
        // Start with a truthy opener so we can observe the app nulling it (the
        // noopener-equivalent it applies after open, by design).
        const popup = {
          closed: false,
          focus: () => {},
          opener: {} as unknown,
        };
        win.__sensitiveOauthOpenerNulled = () => popup.opener === null;
        return popup as unknown as Window;
      }) as typeof window.open;
    });

    const secretRequest = {
      key: "GITHUB_OAUTH",
      reason: "Connect GitHub for PR access",
      status: "pending",
      delivery: {
        mode: "inline_owner_app",
        instruction: "Connect GitHub to continue.",
        privateRouteRequired: true,
        canCollectValueInCurrentChannel: true,
      },
      form: {
        type: "sensitive_request_form",
        kind: "oauth",
        mode: "inline_owner_app",
        fields: [],
        provider: "GitHub",
        scopes: ["repo", "read:user"],
        authorizationUrl: OAUTH_AUTHORIZATION_URL,
        submitLabel: "Connect GitHub",
        statusOnly: true,
      },
    };
    const handles = await installSensitiveRequestChatRoutes(
      page,
      secretRequest,
    );

    await openAppPath(page, "/chat");
    await openChatSheet(page);

    const widget = page.getByTestId("sensitive-request").first();
    await expect(widget).toBeVisible({ timeout: 30_000 });
    // Scopes line and trust copy render — but the raw URL does NOT.
    await expect(widget).toContainText("Scopes: repo, read:user");

    const chatTextBeforeClick =
      (await page.locator("body").textContent()) ?? "";
    expect(chatTextBeforeClick.includes(OAUTH_URL_SUBSTRING)).toBe(false);

    const button = page.getByTestId("sensitive-request-oauth-start").first();
    await expect(button).toContainText("Connect GitHub");
    await button.click();

    // window.open was called with the authorization URL + noopener/noreferrer.
    const openCalls = await page.evaluate(
      () =>
        (
          window as unknown as {
            __sensitiveOauthOpenCalls?: Array<{
              url: string;
              target: string;
              features: string;
            }>;
          }
        ).__sensitiveOauthOpenCalls ?? [],
    );
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]?.url).toBe(OAUTH_AUTHORIZATION_URL);
    // The popup is hardened with `noreferrer` in the features string AND the app
    // nulls `popup.opener` immediately after open (the deliberate noopener
    // equivalent — passing `noopener` in features would make window.open return
    // null and hide a blocked-popup, see SensitiveRequestBlock).
    expect(openCalls[0]?.features).toContain("noreferrer");
    const openerNulled = await page.evaluate(
      () =>
        (
          window as unknown as { __sensitiveOauthOpenerNulled?: () => boolean }
        ).__sensitiveOauthOpenerNulled?.() ?? false,
    );
    expect(openerNulled).toBe(true);

    // After a successful popup open, the button flips to "Authorizing…".
    await expect(button).toContainText(/Authorizing/i, { timeout: 5_000 });

    // The authorization URL must never appear in the chat DOM, before or after.
    const chatTextAfterClick = (await page.locator("body").textContent()) ?? "";
    expect(chatTextAfterClick.includes(OAUTH_URL_SUBSTRING)).toBe(false);

    // It must also never have been POSTed to the chat-message endpoints.
    assertSecretNeverLeakedToChat(handles.chatPostBodies, OAUTH_URL_SUBSTRING);

    // updateSecrets MUST NOT be called for an OAuth flow — the token lands in
    // the vault server-side via the OAuth callback, never via chat.
    expect(handles.secretsPutBodies).toHaveLength(0);
  });
});
