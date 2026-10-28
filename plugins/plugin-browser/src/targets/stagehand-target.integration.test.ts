/** Real HTTP proof for the hosted Stagehand command response boundary. */
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { BrowserService } from "../browser-service.js";
import {
  executeStagehandCommandWithFetch,
  maybeCreateStagehandTarget,
} from "./stagehand-target.js";

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

async function startCommandEndpoint(responses: string[]): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(responses.shift() ?? "{}");
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Stagehand test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}/api/browser-command`;
}

it("rejects malformed success JSON and preserves a valid command result", async () => {
  const commandUrl = await startCommandEndpoint([
    "not-json",
    JSON.stringify({ result: { value: "https://example.com/complete" } }),
    "not-json",
  ]);
  const command = { subaction: "get", getMode: "url" } as const;

  await expect(
    executeStagehandCommandWithFetch(commandUrl, command, fetch),
  ).rejects.toThrow("Stagehand command endpoint returned invalid JSON");
  await expect(
    executeStagehandCommandWithFetch(commandUrl, command, fetch),
  ).resolves.toEqual({
    mode: "cloud",
    subaction: "get",
    value: "https://example.com/complete",
  });

  const target = await maybeCreateStagehandTarget({
    ELIZA_BROWSER_STAGEHAND_AUTO_SETUP: "0",
    ELIZA_BROWSER_STAGEHAND_COMMAND_URL: commandUrl,
  });
  if (!target) throw new Error("Stagehand target was not configured");
  const service = new BrowserService({} as never);
  service.registerTarget(target);
  await expect(
    service.execute({ subaction: "click", selector: "#confirm" }, "stagehand"),
  ).rejects.toMatchObject({
    kind: "UNCERTAIN_OUTCOME",
    targetId: "stagehand",
  });
});
