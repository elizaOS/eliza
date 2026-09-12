/** Exercises interrupted history hydration through the real HTTP client and a local server. */
// @vitest-environment jsdom
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-chat";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        messages: [
          {
            id: "stopped-empty",
            role: "assistant",
            text: "",
            interrupted: true,
          },
          {
            id: "stopped-partial",
            role: "assistant",
            text: "Part of the answer",
            interrupted: true,
          },
          { id: "ordinary-empty", role: "assistant", text: "" },
          { id: "ordinary", role: "assistant", text: "A complete answer." },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

it("preserves stopped empty and partial replies while ordinary empty replies retain failure normalization", async () => {
  const client = new ElizaClient(baseUrl);
  const { messages } = await client.getConversationMessages(
    "stopped-conversation",
  );
  expect(
    messages.find((message) => message.id === "stopped-empty"),
  ).toMatchObject({ text: "", interrupted: true });
  expect(
    messages.find((message) => message.id === "stopped-partial"),
  ).toMatchObject({ text: "Part of the answer", interrupted: true });
  expect(
    messages.find((message) => message.id === "ordinary-empty")?.text,
  ).toBe(client.normalizeAssistantText(""));
  expect(
    messages.find((message) => message.id === "ordinary-empty")?.text,
  ).not.toBe("");
  expect(messages.find((message) => message.id === "ordinary")?.text).toBe(
    "A complete answer.",
  );
});
