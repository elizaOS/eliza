/** Real app + useChatSend ownership with controlled HTTP/SSE boundaries; no live model. */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const room = {
  id: "turn-ownership-thread",
  roomId: "turn-ownership-room",
  title: "Turn ownership",
  createdAt: "2026-10-29T00:00:00Z",
  updatedAt: "2026-10-29T00:00:00Z",
};
async function fixture(page: Page) {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await page.route("**/api/conversations", (route) =>
    route.fulfill({ json: { conversations: [room] } }),
  );
  await page.route("**/api/conversations/*/messages**", (route) =>
    route.fulfill({ json: { messages: [] } }),
  );
  await page.addInitScript(() => {
    const state = {
      posts: [] as unknown[],
      stops: [] as unknown[],
      releaseStop: () => {},
      receipt: "hold",
    };
    Object.assign(window, { turnProbe: state });
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (
        init?.method === "POST" &&
        url.pathname.endsWith("/messages/stream")
      ) {
        state.posts.push(JSON.parse(String(init.body)));
        const encoder = new TextEncoder();
        const count = state.posts.length;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "token", text: count === 1 ? "First partial reply" : "Replacement reply" })}\n\n`,
                ),
              );
              if (count > 1) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "done", fullText: "Replacement reply", agentName: "Eliza" })}\n\n`,
                  ),
                );
                controller.close();
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (init?.method === "POST" && url.pathname.endsWith("/abort")) {
        const request = JSON.parse(String(init.body));
        state.stops.push({
          roomId: url.pathname.split("/").at(-2),
          ...request,
        });
        if (state.receipt === "hold")
          await new Promise<void>((resolve) => {
            state.releaseStop = resolve;
          });
        return new Response(
          JSON.stringify({
            aborted: state.receipt !== "false",
            roomId:
              state.receipt === "wrong-room"
                ? "foreign"
                : url.pathname.split("/").at(-2),
            reason:
              state.receipt === "wrong-reason" ? "foreign" : request.reason,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return original(input, init);
    };
  });
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
}
const probe = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as { turnProbe: { posts: unknown[]; stops: unknown[] } }
    ).turnProbe;
    return { posts: state.posts, stops: state.stops };
  });
async function send(page: Page, text: string) {
  await page.getByTestId("chat-composer-textarea").fill(text);
  await page.getByTestId("chat-composer-action").click();
}

test("held Stop prevents replacement dispatch until the matching receipt", async ({
  page,
}, info) => {
  await fixture(page);
  await send(page, "First request");
  await expect.poll(async () => (await probe(page)).posts.length).toBe(1);
  await page.getByTestId("chat-composer-stop").click();
  await expect.poll(async () => (await probe(page)).stops.length).toBe(1);
  await send(page, "Replacement request");
  await page.waitForTimeout(400);
  expect((await probe(page)).posts).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("waiting-for-stop.png") });
  await page.evaluate(() =>
    (
      window as unknown as { turnProbe: { releaseStop: () => void } }
    ).turnProbe.releaseStop(),
  );
  await expect.poll(async () => (await probe(page)).posts.length).toBe(2);
  await expect(
    page.getByTestId("thread-line").filter({ hasText: "Replacement reply" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("replacement-complete.png") });
  const { posts, stops } = await probe(page);
  expect(stops).toEqual([{ roomId: room.roomId, reason: "ui-chat-stop" }]);
  expect((posts[0] as { clientMessageId: string }).clientMessageId).not.toBe(
    (posts[1] as { clientMessageId: string }).clientMessageId,
  );
});
for (const receipt of ["false", "wrong-room", "wrong-reason"])
  test(`${receipt} Stop receipt preserves the replacement draft`, async ({
    page,
  }) => {
    await fixture(page);
    await page.evaluate((receipt) => {
      (
        window as unknown as { turnProbe: { receipt: string } }
      ).turnProbe.receipt = receipt;
    }, receipt);
    await send(page, "First request");
    await expect.poll(async () => (await probe(page)).posts.length).toBe(1);
    await page.getByTestId("chat-composer-stop").click();
    await expect.poll(async () => (await probe(page)).stops.length).toBe(1);
    await send(page, "Keep this draft");
    await expect(page.getByTestId("chat-composer-textarea")).toHaveValue(
      "Keep this draft",
    );
    expect((await probe(page)).posts).toHaveLength(1);
  });
