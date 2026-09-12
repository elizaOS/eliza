/** Exercises sandbox recovery contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import { DockerSSHClient } from "../docker-ssh";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
} from "./test-support/database.js";
import { customSandbox } from "./test-support/fixtures.js";
import { installReplacementLifecycleSimulation } from "./test-support/replacement.js";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
function restoreWebSocketPair() {
  if (originalWebSocketPair)
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  else Reflect.deleteProperty(globalThis, "WebSocketPair");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});

let restoreDatabase: (() => void) | undefined;
let restoreReplacement: (() => void) | undefined;
let billing: ReturnType<typeof installSandboxBillingSimulation>;
beforeAll(async () => {
  restoreDatabase = installSandboxDatabaseSimulation();
  restoreReplacement = await installReplacementLifecycleSimulation();
  billing = installSandboxBillingSimulation();
});
afterAll(() => {
  billing.restore();
  restoreReplacement?.();
  restoreDatabase?.();
});
describe("ElizaSandboxService recoverDisconnected", () => {
  function disconnectedSandbox(): AgentSandbox {
    return { ...customSandbox(), status: "disconnected" };
  }

  test("a forged Shared row is rejected before bridge, SSH, or write effects", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...disconnectedSandbox(),
      execution_tier: "shared",
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      sandbox,
    );
    const replicaSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg");
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockResolvedValue(undefined);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(undefined);
    const sshSpy = spyOn(DockerSSHClient, "getClient").mockReturnValue({
      exec: mock(async () => "must not execute"),
    } as unknown as DockerSSHClient);
    const bridgeFetch = mock(async () => new Response("must not probe", { status: 200 }));
    globalThis.fetch = bridgeFetch;

    try {
      await expect(
        new ElizaSandboxService().recoverDisconnected(sandbox.id, sandbox.organization_id),
      ).resolves.toBe("gone");
      expect(primarySpy).toHaveBeenCalledTimes(1);
      expect(replicaSpy).not.toHaveBeenCalled();
      expect(bridgeFetch).not.toHaveBeenCalled();
      expect(nodeSpy).not.toHaveBeenCalled();
      expect(sshSpy).not.toHaveBeenCalled();
      expect(casSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      primarySpy.mockRestore();
      replicaSpy.mockRestore();
      casSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      sshSpy.mockRestore();
    }
  });

  test("recovers a reachable disconnected agent via guarded compare-and-set", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = disconnectedSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
      async () => sandbox,
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => ({ ...sandbox, status: "running" }));
    globalThis.fetch = mock(async () => new Response("ok", { status: 200 }));

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("recovered");
      expect(casSpy).toHaveBeenCalledTimes(1);
      expect(casSpy.mock.calls[0]).toEqual([sandbox]);
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });

  test("recovers a reachable errored agent left behind by blue/green status drift", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      status: "error",
      error_message: null,
      previous_image_digest: "sha256:old",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
      async () => sandbox,
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => ({ ...sandbox, status: "running", error_message: null }));
    globalThis.fetch = mock(async () => new Response("ok", { status: 200 }));

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("recovered");
      expect(casSpy).toHaveBeenCalledTimes(1);
      expect(casSpy.mock.calls[0]).toEqual([sandbox]);
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });

  test("does NOT revive when the row left disconnected mid-probe (CAS loses -> gone)", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = disconnectedSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
      async () => sandbox,
    );
    // Probe succeeds, but the agent was deleted/stopped/re-provisioned during the
    // probe → guarded update matches 0 rows. Must report "gone", never resurrect.
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => undefined);
    globalThis.fetch = mock(async () => new Response("ok", { status: 200 }));

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("gone");
      expect(casSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });

  test("reports unreachable without writing when the bridge does not answer", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = disconnectedSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
      async () => sandbox,
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => undefined);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(undefined);
    globalThis.fetch = mock(async () => new Response("nope", { status: 502 }));

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("unreachable");
      expect(casSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
      nodeSpy.mockRestore();
    }
    // The unreachable path burns real probe-retry backoff (~5-6s of sleeps);
    // under the multi-suite coverage lane that overruns the default 5s budget.
  }, 20_000);

  test("reports gone (and never probes) when the row is no longer disconnected", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
      async () => ({
        ...customSandbox(),
        status: "running",
      }),
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => undefined);
    let probed = false;
    globalThis.fetch = mock(async () => {
      probed = true;
      return new Response("ok", { status: 200 });
    });

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
        "22222222-2222-4222-8222-222222222222",
      );
      expect(result).toBe("gone");
      expect(probed).toBe(false);
      expect(casSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });
});
