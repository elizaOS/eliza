/**
 * Proves pending Dedicated agents remain isolated from the Shared runtime with
 * deterministic repository fixtures and no container transport.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { ElizaSandboxService } from "./eliza-sandbox";

afterEach(() => {
  mock.restore();
});

describe("ElizaSandboxService Dedicated isolation", () => {
  test("refuses bridge calls until the Dedicated container is running", async () => {
    const findRunningSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      undefined,
    );
    const findByIdSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg");
    const service = new ElizaSandboxService();

    for (const method of ["message.send", "status.get"] as const) {
      const response = await service.bridge("agent-1", "org-1", {
        jsonrpc: "2.0",
        id: method,
        method,
        params: method === "message.send" ? { text: "hello" } : {},
      });

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: method,
        error: { code: -32000, message: "Sandbox is not running" },
      });
    }

    expect(findRunningSpy).toHaveBeenCalledTimes(2);
    expect(findByIdSpy).not.toHaveBeenCalled();
  });

  test("does not expose a Dedicated character through the Shared adapter", async () => {
    const findRunningSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      undefined,
    );
    const findByIdSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg");

    await expect(
      new ElizaSandboxService().getSharedRuntimeCharacter("agent-1", "org-1"),
    ).resolves.toBeNull();

    expect(findRunningSpy).toHaveBeenCalledWith("agent-1", "org-1");
    expect(findByIdSpy).not.toHaveBeenCalled();
  });
});
