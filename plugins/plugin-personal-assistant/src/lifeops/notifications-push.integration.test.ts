/** Real loopback-HTTP proof that an ntfy publish needs provider evidence. */
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { sendPush } from "./notifications-push.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      server.close();
      await once(server, "close");
      servers.delete(server);
    }),
  );
});

async function startProvider(responses: string[]): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(responses.shift() ?? "{}");
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Ntfy test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

it("rejects an accepted publish without a message id and keeps a valid receipt", async () => {
  const baseUrl = await startProvider([
    "not-json",
    "{}",
    JSON.stringify({ id: "provider-message-1", time: 1_797_000_000 }),
  ]);
  const config = { baseUrl, defaultTopic: "owner-reminders" };
  const request = { title: "Reminder", message: "Take medicine" };

  await expect(sendPush(request, config)).rejects.toThrow(
    "Ntfy publish returned invalid JSON",
  );
  await expect(sendPush(request, config)).rejects.toThrow(
    "Ntfy publish returned no message id",
  );
  await expect(sendPush(request, config)).resolves.toEqual({
    messageId: "provider-message-1",
    deliveredAt: "2026-12-11T14:40:00.000Z",
  });
});
