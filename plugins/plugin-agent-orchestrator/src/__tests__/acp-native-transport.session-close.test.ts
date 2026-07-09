/**
 * Agent-initiated session-lifecycle notifications over native ACP: an agent
 * server (e.g. the elizaos eliza-code ACP server) sends `session/close` /
 * `session/cancel` to the client once its work is done. The client's
 * `handleClientRequest` must acknowledge them like `session/update` — before
 * this was handled, they fell through to the default case and answered
 * JSON-RPC "Method not found", which surfaced to the user as a spurious
 * "Couldn't finish … session/close" AFTER an otherwise-complete task.
 */

import { describe, expect, it } from "vitest";
import { NativeAcpClient } from "../services/acp-native-transport";

type ClientRequestHandler = {
  handleClientRequest: (method: string, params: unknown) => Promise<unknown>;
};

function makeClient(): ClientRequestHandler {
  return new NativeAcpClient({
    command: "true",
    cwd: "/tmp",
  }) as unknown as ClientRequestHandler;
}

describe("NativeAcpClient handleClientRequest session lifecycle", () => {
  it("acknowledges agent-initiated session/close instead of Method not found", async () => {
    const client = makeClient();
    await expect(
      client.handleClientRequest("session/close", { sessionId: "s-1" }),
    ).resolves.toEqual({});
  });

  it("acknowledges agent-initiated session/cancel", async () => {
    const client = makeClient();
    await expect(
      client.handleClientRequest("session/cancel", { sessionId: "s-1" }),
    ).resolves.toEqual({});
  });

  it("acknowledges session/update (pre-existing contract preserved)", async () => {
    const client = makeClient();
    await expect(
      client.handleClientRequest("session/update", {}),
    ).resolves.toEqual({});
  });

  it("still rejects genuinely unknown client methods", async () => {
    const client = makeClient();
    await expect(
      client.handleClientRequest("session/definitely_not_a_method", {}),
    ).rejects.toThrow(/Unsupported ACP client method/);
  });
});
