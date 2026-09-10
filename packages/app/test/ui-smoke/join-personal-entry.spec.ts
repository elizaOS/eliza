/**
 * Exercises Shared and existing Dedicated entry through the built renderer,
 * real join controller, HTTP client and browser persistence. Account transport
 * is fulfilled locally; no real provider, account or paid runtime is used.
 */
import { writeFile } from "node:fs/promises";
import { expect, type Locator, test } from "@playwright/test";
import { installDefaultAppRoutes } from "./helpers";
import { seedStewardSession } from "./helpers/test-auth";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

const personalId = "personal:00000000-0000-5000-8000-000000000001";
const dedicatedId = "00000000-0000-4000-8000-000000000002";

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile-width", width: 390, height: 844 },
]) {
  test.describe(viewport.name, () => {
    // Video dimensions are fixed when the context is created. Resizing the
    // page afterwards leaves portrait evidence inside a landscape canvas.
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    for (const runtime of ["shared", "dedicated"] as const) {
      test(`Personal ${runtime} entry recovers without activation on ${viewport.name}`, async ({
        page,
      }, testInfo) => {
        const requests: { method: string; pathname: string }[] = [];
        const unexpectedRemoteRequests: string[] = [];
        const pageErrors: string[] = [];
        const consoleMessages: { type: string; message: string }[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("console", (message) =>
          consoleMessages.push({
            type: message.type(),
            message: message.text(),
          }),
        );
        // Register first so normal local fixtures can answer, but any unhandled
        // remote request fails the test instead of reaching a real Cloud host.
        await page.route("https://**", async (route) => {
          const url = new URL(route.request().url());
          unexpectedRemoteRequests.push(`${url.origin}${url.pathname}`);
          await route.abort("blockedbyclient");
        });
        await seedStewardSession(page, { jwt: true });
        await installDefaultAppRoutes(page);
        await page.route("**/api/auth/steward-session", (route) =>
          route.fulfill({ json: { success: true } }),
        );
        // Fail unexpected lifecycle traffic at the transport boundary, including
        // quote/adoption reads: ordinary entry needs only the personal identity.
        await page.route(/\/api\/v1\/eliza\/agents(?:\/|$)/, async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          if (
            request.method() !== "GET" ||
            /\/(upgrade-tier|adopt|provision|start|wake|resume)(\/|$)/.test(
              pathname,
            )
          ) {
            requests.push({ method: request.method(), pathname });
            await route.abort("blockedbyclient");
            return;
          }
          await route.fallback();
        });
        let identityReads = 0;
        let conversationReads = 0;
        let conversationCreates = 0;
        let conversationMessageReads = 0;
        let conversationSends = 0;
        let available = false;
        const activeAgentId = runtime === "shared" ? personalId : dedicatedId;
        const corsHeaders = () => ({
          "access-control-allow-origin": new URL(page.url()).origin,
          "access-control-allow-credentials": "true",
        });
        await page.route("https://api.eliza.app/api/v1/user", async (route) => {
          if (route.request().method() !== "GET") {
            await route.fallback();
            return;
          }
          await route.fulfill({
            headers: corsHeaders(),
            json: { success: true, data: { id: "ui-smoke-user" } },
          });
        });
        await page.route(
          "https://api.eliza.app/api/v1/credits/balance",
          async (route) => {
            if (route.request().method() !== "GET") {
              await route.fallback();
              return;
            }
            await route.fulfill({
              headers: corsHeaders(),
              json: { balance: 10 },
            });
          },
        );
        await page.route(
          `https://api.eliza.app/api/v1/eliza/agents/${dedicatedId}`,
          async (route) => {
            if (route.request().method() !== "GET") {
              await route.fallback();
              return;
            }
            await route.fulfill({
              headers: corsHeaders(),
              json: {
                success: true,
                data: { id: dedicatedId, name: "Eliza", status: "running" },
              },
            });
          },
        );
        const runtimePrefixes = [
          `https://${dedicatedId}.cloud.eliza.app/api/`,
          `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(personalId)}/api/`,
        ];
        const expectedRuntimePrefix =
          runtimePrefixes[runtime === "dedicated" ? 0 : 1];
        const restoredMessage = `Personal ${runtime} conversation restored.`;
        const userMessage = `Check my ${runtime} conversation.`;
        const messages: {
          id: string;
          role: "user" | "assistant";
          text: string;
          timestamp: number;
        }[] = [];
        const conversation = {
          id: "personal-entry-conversation",
          roomId: "personal-entry-room",
          title: "Personal entry",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
        await page.route(
          (url) =>
            runtimePrefixes.some((prefix) => url.href.startsWith(prefix)),
          async (route) => {
            const request = route.request();
            const prefix = runtimePrefixes.find((candidate) =>
              request.url().startsWith(candidate),
            );
            if (!prefix) throw new Error("Unexpected runtime fixture origin");
            // A correct persisted binding is insufficient if the HTTP client
            // still dispatches conversation traffic to the other runtime.
            expect(prefix).toBe(expectedRuntimePrefix);
            const path = request.url().slice(prefix.length).split("?")[0];
            const method = request.method();
            const fulfill = (json: object) =>
              route.fulfill({ headers: corsHeaders(), json });
            // These app-state writes are not runtime lifecycle operations. Keep
            // the allowlist exact; every other write reaches the rejection guard.
            if (
              method === "POST" &&
              ["apps/overlay-presence", "views/__all__/navigate"].includes(path)
            ) {
              await fulfill({ success: true });
              return;
            }
            if (path === "conversations" && method === "GET") {
              conversationReads += 1;
              await fulfill({
                conversations: conversationCreates ? [conversation] : [],
              });
              return;
            }
            if (path === "conversations" && method === "POST") {
              conversationCreates += 1;
              await fulfill({ conversation });
              return;
            }
            if (
              path === `conversations/${conversation.id}/messages/stream` &&
              method === "POST"
            ) {
              expect(request.postDataJSON()).toMatchObject({
                text: userMessage,
              });
              conversationSends += 1;
              messages.push(
                {
                  id: "personal-entry-user",
                  role: "user",
                  text: userMessage,
                  timestamp: Date.now(),
                },
                {
                  id: "personal-entry-assistant",
                  role: "assistant",
                  text: restoredMessage,
                  timestamp: Date.now(),
                },
              );
              await route.fulfill({
                headers: corsHeaders(),
                contentType: "text/event-stream",
                body:
                  `data: ${JSON.stringify({ type: "token", text: restoredMessage, fullText: restoredMessage })}\n\n` +
                  `data: ${JSON.stringify({ type: "done", fullText: restoredMessage, agentName: "Eliza" })}\n\n`,
              });
              return;
            }
            if (method === "GET") {
              if (path === "agent/events") {
                await fulfill({
                  events: [],
                  latestEventId: null,
                  totalBuffered: 0,
                  replayed: true,
                });
                return;
              }
              if (path === `conversations/${conversation.id}`) {
                await fulfill({ conversation });
                return;
              }
              if (path === `conversations/${conversation.id}/messages`) {
                conversationMessageReads += 1;
                await fulfill({ messages });
                return;
              }
              if (path === `conversations/${conversation.id}/greeting`) {
                await fulfill({ message: null });
                return;
              }
            }
            await route.fallback();
          },
        );
        await page.route("**/api/v1/eliza/personal", async (route) => {
          expect(route.request().method()).toBe("GET");
          identityReads += 1;
          await route.fulfill(
            available
              ? {
                  json: {
                    success: true,
                    data: {
                      identity: {
                        id: personalId,
                        displayName: "Eliza",
                        runtime,
                        activeAgentId,
                        apiBase:
                          runtime === "dedicated"
                            ? `https://${dedicatedId}.cloud.eliza.app`
                            : `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(personalId)}`,
                      },
                    },
                  },
                }
              : {
                  status: 503,
                  json: {
                    success: false,
                    error: "Your Eliza is temporarily unavailable. Try again.",
                  },
                },
          );
        });
        await page.goto("/join");
        await expect(page.getByRole("alert")).toContainText(
          "Your Eliza is temporarily unavailable. Try again.",
        );
        await expect(
          page.getByRole("button", { name: "Add credits" }),
        ).toHaveCount(0);
        expect(identityReads).toBe(1);
        expect(requests).toEqual([]);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: testInfo.outputPath("entry-error.jpg"),
          fullPage: true,
        });

        // Reload must remain a read-only recovery path, not an implicit upgrade.
        await page.reload();
        await expect(page.getByRole("alert")).toContainText(
          "Your Eliza is temporarily unavailable. Try again.",
        );
        expect(identityReads).toBe(2);
        expect(requests).toEqual([]);

        available = true;
        const retry = page.getByRole("button", {
          name: "Try again",
          exact: true,
        });
        const retryRestBackground = await retry.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        const signOut = page.getByRole("button", {
          name: "Sign out",
          exact: true,
        });
        const signOutRestBackground = await signOut.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        const captureSettledFocus = async (
          control: Locator,
          restBackground: string,
          filename: string,
        ) => {
          // Focus ownership precedes the CSS color transition. A changed color
          // alone can still be its first, nearly invisible interpolated frame.
          await expect
            .poll(() =>
              control.evaluate((element, resting) => {
                const background = getComputedStyle(element).backgroundColor;
                return {
                  focused: document.activeElement === element,
                  changed: background !== resting,
                  settled: element
                    .getAnimations()
                    .every(
                      (animation) =>
                        !animation.pending &&
                        animation.playState === "finished",
                    ),
                };
              }, restBackground),
            )
            .toEqual({ focused: true, changed: true, settled: true });
          await page.screenshot({
            path: testInfo.outputPath(filename),
            fullPage: true,
          });
        };
        await page.keyboard.press("Tab");
        await expect(retry).toBeFocused();
        await captureSettledFocus(
          retry,
          retryRestBackground,
          "entry-retry-focus.jpg",
        );
        await page.keyboard.press("Tab");
        await expect(signOut).toBeFocused();
        await captureSettledFocus(
          signOut,
          signOutRestBackground,
          "entry-sign-out-focus.jpg",
        );
        await page.keyboard.press("Shift+Tab");
        await expect(retry).toBeFocused();
        await retry.press("Enter");
        await expect(page).toHaveURL(/\/chat$/);
        const readBinding = () =>
          page.evaluate(() => {
            const value = localStorage.getItem("elizaos:active-server");
            if (!value) return null;
            const server = JSON.parse(value);
            return {
              id: server.id,
              runtime: server.cloudRuntime,
              activeAgentId: server.cloudRuntimeAgentId,
            };
          });
        await expect
          .poll(readBinding)
          .toEqual({ id: `cloud:${personalId}`, runtime, activeAgentId });
        await expect(page.getByTestId("chat-pill")).toBeVisible({
          timeout: 60_000,
        });
        expect(identityReads).toBeGreaterThanOrEqual(3);
        expect(requests).toEqual([]);
        expect(pageErrors).toEqual([]);
        // Exercise the real composer and stream client against the isolated
        // runtime store. A fresh empty thread has no history to reveal yet.
        const composer = page.getByTestId("chat-composer-textarea");
        await expect(composer).toBeEnabled();
        await composer.fill(userMessage);
        await page.getByTestId("chat-composer-action").click();
        const showConversation = async () => {
          await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
            "data-conversation-id",
            conversation.id,
          );
          // The pill first reveals the composer; its separate accessible
          // disclosure then opens history. Never press the inert hidden handle.
          const pill = page.getByRole("button", {
            name: "open chat",
            exact: true,
          });
          if (await pill.count()) await pill.press("ArrowUp");
          if (
            (await page
              .getByTestId("chat-sheet")
              .getAttribute("data-variant")) !== "open"
          ) {
            await page
              .getByRole("button", {
                name: "drag up to open chat",
                exact: true,
              })
              .press("ArrowUp");
          }
          await expect(page.getByTestId("chat-overlay")).toHaveAttribute(
            "data-open",
            "true",
          );
          for (const text of [userMessage, restoredMessage]) {
            const line = page
              .getByTestId("thread-line")
              .filter({ hasText: text })
              .first();
            await expect(line).toBeVisible();
            // Mounted text can still be clipped by the opening spring. Capture
            // only after both messages are fully inside the visible thread.
            await expect(line).toBeInViewport({ ratio: 1 });
          }
          await expect(
            page.getByTestId("chat-composer-textarea"),
          ).toBeEnabled();
        };
        await showConversation();
        await page.screenshot({
          path: testInfo.outputPath("entry-complete.jpg"),
          fullPage: true,
        });
        const messageReadsBeforeReload = conversationMessageReads;
        await page.reload();
        await expect(page.getByTestId("chat-pill")).toBeVisible({
          timeout: 60_000,
        });
        await expect(page).toHaveURL(/\/chat$/);
        await expect
          .poll(readBinding)
          .toEqual({ id: `cloud:${personalId}`, runtime, activeAgentId });
        await showConversation();
        await page.screenshot({
          path: testInfo.outputPath("entry-restored.jpg"),
          fullPage: true,
        });
        expect(requests).toEqual([]);
        expect(pageErrors).toEqual([]);
        expect(unexpectedRemoteRequests).toEqual([]);
        expect(conversationReads).toBeGreaterThanOrEqual(2);
        expect(conversationCreates).toBe(1);
        expect(conversationSends).toBe(1);
        expect(conversationMessageReads).toBeGreaterThan(
          messageReadsBeforeReload,
        );
        expect(
          consoleMessages.filter(
            (message) =>
              message.type === "error" &&
              message.message !==
                "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
          ),
        ).toEqual([]);
        await writeFile(
          testInfo.outputPath("entry-receipts.json"),
          JSON.stringify(
            {
              scope:
                "built renderer with synthetic account transport; not staging",
              runtime,
              identityReads,
              conversationReads,
              conversationCreates,
              conversationMessageReads,
              conversationSends,
              forbiddenRequests: requests,
              unexpectedRemoteRequests,
              pageErrors,
              consoleMessages,
            },
            null,
            2,
          ),
        );
        const video = page.video();
        await page.context().close();
        if (video)
          await saveBrowserVideoArtifact({
            video,
            testInfo,
            basename: "personal-entry",
          });
      });
    }
  });
}
