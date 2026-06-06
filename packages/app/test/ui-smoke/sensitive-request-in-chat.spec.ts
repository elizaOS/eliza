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
      timestamp: NOW_MS - 5_000,
    },
    {
      id: "seed-assistant-1",
      role: "assistant" as const,
      text: seedAssistantText,
      timestamp: NOW_MS - 2_000,
      secretRequest,
    },
  ];
  const chatPostBodies: string[] = [];
  const secretsPutBodies: JsonRecord[] = [];

  await page.route("**/api/conversations", async (route) => {
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

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}`,
    async (route) => {
      if (route.request().method() === "PATCH") {
        await fulfillJson(route, { conversation });
        return;
      }
      if (route.request().method() === "GET") {
        await fulfillJson(route, { conversation });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages`,
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

  return { chatPostBodies, secretsPutBodies };
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
        open: typeof window.open;
      };
      win.__sensitiveOauthOpenCalls = [];
      win.open = ((
        url?: string | URL,
        target?: string,
        features?: string,
      ) => {
        win.__sensitiveOauthOpenCalls.push({
          url: typeof url === "string" ? url : String(url ?? ""),
          target: typeof target === "string" ? target : "",
          features: typeof features === "string" ? features : "",
        });
        return { closed: false, focus: () => {} } as unknown as Window;
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
    expect(openCalls[0]?.features).toContain("noopener");
    expect(openCalls[0]?.features).toContain("noreferrer");

    // After a successful popup open, the button flips to "Authorizing…".
    await expect(button).toContainText(/Authorizing/i, { timeout: 5_000 });

    // The authorization URL must never appear in the chat DOM, before or after.
    const chatTextAfterClick =
      (await page.locator("body").textContent()) ?? "";
    expect(chatTextAfterClick.includes(OAUTH_URL_SUBSTRING)).toBe(false);

    // It must also never have been POSTed to the chat-message endpoints.
    assertSecretNeverLeakedToChat(handles.chatPostBodies, OAUTH_URL_SUBSTRING);

    // updateSecrets MUST NOT be called for an OAuth flow — the token lands in
    // the vault server-side via the OAuth callback, never via chat.
    expect(handles.secretsPutBodies).toHaveLength(0);
  });
});
