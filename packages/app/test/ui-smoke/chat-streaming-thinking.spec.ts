// Browser-level evidence for #10712: the shipped chat overlay consumes a
// deterministic token stream, paints partial text before completion, and only
// shows the Thinking disclosure after the terminal frame carries `thought`.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const CONVERSATION_ID = "streaming-thinking-conversation";
const ROOM_ID = "streaming-thinking-room";
const USER_TEXT = "show me streamed thinking";
const TOKENS = ["Streaming ", "tokens ", "arrived."];
const FINAL_TEXT = TOKENS.join("");
const THOUGHT =
  "The mock provider emitted tokens first, then sent this compact reasoning on done.";
const OUT_DIR = path.join(
  process.cwd(),
  "test-results",
  "ui-smoke-artifacts",
  "10712-chat-thinking-streaming",
);

interface StreamingLogEvent {
  kind: "request" | "frame" | "close";
  payload?: unknown;
}

async function installStreamingThinkingRoutes(page: Page): Promise<{
  events: StreamingLogEvent[];
}> {
  const now = Date.now();
  const conversation = {
    id: CONVERSATION_ID,
    roomId: ROOM_ID,
    title: "Streaming thinking",
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  const messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    reasoning?: string;
    source: string;
    roomId: string;
    timestamp: number;
  }> = [];
  const events: StreamingLogEvent[] = [];
  let streamCompleted = false;
  const ensureAssistantMessage = () => {
    if (messages.some((message) => message.role === "assistant")) return;
    messages.push({
      id: "streaming-thinking-assistant",
      role: "assistant",
      text: FINAL_TEXT,
      reasoning: THOUGHT,
      source: "eliza",
      roomId: ROOM_ID,
      timestamp: Date.now(),
    });
  };

  await page.exposeFunction(
    "__recordStreamingThinkingEvent",
    (event: StreamingLogEvent) => {
      events.push(event);
      if (event.kind === "request") {
        const payload = event.payload as { text?: string } | undefined;
        messages.push({
          id: "streaming-thinking-user",
          role: "user",
          text: payload?.text ?? USER_TEXT,
          source: "eliza",
          roomId: ROOM_ID,
          timestamp: Date.now(),
        });
        return;
      }
      if (
        event.kind === "frame" &&
        (event.payload as { type?: string } | undefined)?.type === "done"
      ) {
        streamCompleted = true;
        ensureAssistantMessage();
      }
    },
  );
  await page.exposeFunction("__recordStreamingThinkingDone", () => {
    streamCompleted = true;
    ensureAssistantMessage();
  });

  await page.addInitScript(
    ({ conversationId, tokens, finalText, thought }) => {
      const nativeFetch = window.fetch.bind(window);
      const encoder = new TextEncoder();
      const streamPath = `/api/conversations/${conversationId}/messages/stream`;
      window.fetch = async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        if (!request.url.includes(streamPath)) {
          return nativeFetch(input, init);
        }
        const requestBody = await request
          .clone()
          .text()
          .catch(() => "{}");
        const parsedBody = (() => {
          try {
            return JSON.parse(requestBody);
          } catch {
            return {};
          }
        })();
        await (
          window as unknown as {
            __recordStreamingThinkingEvent?: (
              event: StreamingLogEvent,
            ) => Promise<void>;
          }
        ).__recordStreamingThinkingEvent?.({
          kind: "request",
          payload: parsedBody,
        });

        let accumulated = "";
        const frames = [
          { type: "status", kind: "thinking" },
          ...tokens.map((token) => {
            accumulated += token;
            return { type: "token", text: token, fullText: accumulated };
          }),
          {
            type: "done",
            fullText: finalText,
            agentName: "Eliza",
            thought,
          },
        ];
        let canceled = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              let index = 0;
              const recordEvent = (event: StreamingLogEvent) =>
                (
                  window as unknown as {
                    __recordStreamingThinkingEvent?: (
                      event: StreamingLogEvent,
                    ) => Promise<void>;
                  }
                ).__recordStreamingThinkingEvent?.(event) ?? Promise.resolve();
              const sendNext = async () => {
                const frame = frames[index];
                if (canceled) return;
                if (!frame) {
                  await (
                    window as unknown as {
                      __recordStreamingThinkingDone?: () => Promise<void>;
                    }
                  ).__recordStreamingThinkingDone?.();
                  await recordEvent({ kind: "close" });
                  try {
                    controller.close();
                  } catch {
                    // The client may cancel immediately after the terminal
                    // frame; that is equivalent to a clean SSE disconnect.
                  }
                  return;
                }
                await recordEvent({
                  kind: "frame",
                  payload: frame,
                });
                if (canceled) return;
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
                );
                index += 1;
                window.setTimeout(sendNext, index === 1 ? 120 : 420);
              };
              window.setTimeout(sendNext, 40);
            },
            cancel() {
              canceled = true;
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      };
    },
    {
      conversationId: CONVERSATION_ID,
      tokens: TOKENS,
      finalText: FINAL_TEXT,
      thought: THOUGHT,
    },
  );

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [conversation] }),
      });
      return;
    }
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/conversations/${CONVERSATION_ID}`, async (route) => {
    if (
      route.request().method() === "GET" ||
      route.request().method() === "PATCH"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages`,
    async (route) => {
      if (route.request().method() === "GET") {
        if (streamCompleted) ensureAssistantMessage();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages }),
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/greeting**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "Ready.", localInference: null }),
      });
    },
  );

  await page.route("**/api/avatar/vrm", async (route) => {
    const method = route.request().method();
    if (method !== "HEAD" && method !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 204 });
  });

  await page.route("**/api/apps/overlay-presence", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  return { events };
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

async function writeEvidenceFile(name: string, body: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, name), body);
}

for (const viewport of [
  { name: "desktop", size: { width: 1280, height: 900 } },
  { name: "mobile", size: { width: 390, height: 844 } },
] as const) {
  test(`chat overlay streams tokens and reveals Thinking on ${viewport.name}`, async ({
    page,
  }) => {
    const consoleLines: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => consoleLines.push(msg.text()));
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.setViewportSize(viewport.size);
    await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
    await installDefaultAppRoutes(page);
    const { events } = await installStreamingThinkingRoutes(page);

    await openAppPath(page, "/chat");
    await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
      timeout: 60_000,
    });
    const composer = page
      .locator(
        '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
      )
      .first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill(USER_TEXT);
    await page.getByTestId("chat-composer-action").click();

    await expect(
      page.getByTestId("thread-line").filter({ hasText: TOKENS[0] }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId("thread-line").filter({ hasText: FINAL_TEXT }).first(),
    ).toHaveCount(0);
    await screenshot(page, `${viewport.name}-mid-stream`);

    await expect(
      page.getByTestId("thread-line").filter({ hasText: FINAL_TEXT }).first(),
    ).toBeVisible({ timeout: 20_000 });
    const thinking = page
      .getByTestId("chat-thread")
      .getByRole("button", { name: "Thinking" });
    await expect(thinking).toBeVisible({ timeout: 10_000 });
    await expect(thinking).toHaveAttribute("aria-expanded", "false");
    await page.waitForTimeout(700);
    await screenshot(page, `${viewport.name}-thinking-collapsed`);

    await thinking.click();
    await expect(thinking).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(THOUGHT)).toBeVisible();
    await page.waitForTimeout(200);
    await screenshot(page, `${viewport.name}-thinking-expanded`);

    expect(
      events
        .filter((event) => event.kind === "frame")
        .map((event) => (event.payload as { type?: string }).type),
    ).toEqual(["status", "token", "token", "token", "done"]);
    expect(pageErrors, "no uncaught page errors").toEqual([]);

    await writeEvidenceFile(
      `${viewport.name}-streaming-events.json`,
      `${JSON.stringify(events, null, 2)}\n`,
    );
    await writeEvidenceFile(
      `${viewport.name}-console.log`,
      `${consoleLines.join("\n") || "N/A - no console output"}\n`,
    );

    await test.info().attach(`${viewport.name} streaming events`, {
      body: JSON.stringify(events, null, 2),
      contentType: "application/json",
    });
    await test.info().attach(`${viewport.name} console`, {
      body: consoleLines.join("\n") || "N/A - no console output",
      contentType: "text/plain",
    });
  });
}
