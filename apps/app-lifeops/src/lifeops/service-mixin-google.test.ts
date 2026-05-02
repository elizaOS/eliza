import { describe, expect, it } from "vitest";
import type { StartLifeOpsGoogleConnectorRequest } from "../contracts/index.js";
import { withGoogle } from "./service-mixin-google.js";

class StubBase {
  runtime = { agentId: "agent-google" };

  agentId(): string {
    return this.runtime.agentId;
  }
}

type GoogleConsumer = {
  startGoogleConnector: (
    request: StartLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ) => Promise<unknown>;
};

const Composed = withGoogle(StubBase as never);

function createService(): StubBase & GoogleConsumer {
  return new (Composed as unknown as new () => StubBase & GoogleConsumer)();
}

describe("withGoogle connector ownership", () => {
  it("does not create LifeOps Google grants for agent-side Gmail", async () => {
    const service = createService();

    await expect(
      service.startGoogleConnector(
        {
          side: "agent",
          capabilities: ["google.gmail.triage"],
        },
        new URL("http://127.0.0.1/internal"),
      ),
    ).rejects.toThrow("@elizaos/plugin-gmail-watch");
  });

  it("treats the default agent-side Google connect request as Gmail-owned by the plugin", async () => {
    const service = createService();

    await expect(
      service.startGoogleConnector(
        {
          side: "agent",
        },
        new URL("http://127.0.0.1/internal"),
      ),
    ).rejects.toThrow("@elizaos/plugin-gmail-watch");
  });
});
