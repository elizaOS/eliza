/**
 * Exercises the real elizaOS capability action with deterministic fake world
 * authority and executable broker scripts; the OS process boundary is local.
 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { osCapabilityAction } from "../actions/os-capability";

const AGENT = "00000000-0000-0000-0000-0000000000a9" as UUID;
const OWNER = "00000000-0000-0000-0000-000000000005" as UUID;
const GUEST = "00000000-0000-0000-0000-000000000006" as UUID;
const WORLD = "00000000-0000-0000-0000-000000000012" as UUID;
const ROOM = "00000000-0000-0000-0000-000000000001" as UUID;

const originalRunner = process.env.ELIZAOS_CAPABILITY_RUNNER;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalRunner === undefined)
    delete process.env.ELIZAOS_CAPABILITY_RUNNER;
  else process.env.ELIZAOS_CAPABILITY_RUNNER = originalRunner;
});

function runtimeWithRoles(roles: Record<string, string>): IAgentRuntime {
  return {
    agentId: AGENT,
    getRoom: async (roomId: UUID) => ({ id: roomId, worldId: WORLD }),
    getWorld: async (id: UUID) => ({
      id,
      agentId: AGENT,
      serverId: "server-1",
      metadata: {
        roles,
        roleSources: Object.fromEntries(
          Object.keys(roles).map((entityId) => [entityId, "manual"]),
        ),
      },
    }),
    getSetting: () => undefined,
    getCache: async () => undefined,
    getComponents: async () => [],
    getEntityById: async () => null,
    reportError: vi.fn(),
    logger: { error: vi.fn() },
  } as unknown as IAgentRuntime;
}

function message(
  entityId: UUID,
  content: Record<string, unknown> = {},
): Memory {
  return { entityId, roomId: ROOM, content } as unknown as Memory;
}

async function executableRunner(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "elizaos-broker-"));
  const runner = join(dir, "runner");
  await writeFile(runner, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  await chmod(runner, 0o755);
  process.env.ELIZAOS_CAPABILITY_RUNNER = runner;
}

describe("elizaOS capability action", () => {
  it("is hidden when no executable broker is configured", async () => {
    delete process.env.ELIZAOS_CAPABILITY_RUNNER;
    expect(
      await osCapabilityAction.validate?.(
        {} as never,
        {} as never,
        {} as never,
      ),
    ).toBe(false);
  });

  it("matches the canonical four-action, zero-argument OS contract", () => {
    expect(osCapabilityAction.contexts).toEqual([
      "automation",
      "agent_internal",
      "settings",
    ]);
    expect(osCapabilityAction.parameters).toEqual([
      expect.objectContaining({
        name: "action",
        required: true,
        schema: {
          type: "string",
          enum: [
            "status",
            "privacy_mode",
            "root_status",
            "open_persistent_storage",
          ],
        },
      }),
    ]);
  });

  it("passes one closed command with no trailing argv", async () => {
    await executableRunner();
    const result = await osCapabilityAction.handler?.(
      runtimeWithRoles({ [OWNER]: "OWNER" }),
      message(OWNER),
      undefined,
      { parameters: { action: "open_persistent_storage" } } as never,
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toBe("open-persistent-storage");
  });

  it("rechecks scoped OWNER authority for direct handler invocation", async () => {
    await executableRunner();
    expect(osCapabilityAction.roleGate).toEqual({ minRole: "OWNER" });
    const result = await osCapabilityAction.handler?.(
      runtimeWithRoles({ [GUEST]: "GUEST" }),
      message(GUEST),
      undefined,
      { parameters: { action: "status" } } as never,
    );
    expect(result).toEqual({
      success: false,
      text: "elizaOS capability requires a verified OWNER in a scoped world.",
    });
  });

  it("fails closed when the message has no scoped world", async () => {
    await executableRunner();
    const runtime = runtimeWithRoles({ [OWNER]: "OWNER" });
    runtime.getRoom = async () => null;
    const result = await osCapabilityAction.handler?.(
      runtime,
      message(OWNER),
      undefined,
      { parameters: { action: "status" } } as never,
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("verified OWNER in a scoped world");
  });

  it("rejects unsupported operations and any argument vector", async () => {
    await executableRunner();
    const runtime = runtimeWithRoles({ [OWNER]: "OWNER" });
    const unsupported = await osCapabilityAction.handler?.(
      runtime,
      message(OWNER),
      undefined,
      { parameters: { action: "service" } } as never,
    );
    expect(unsupported).toEqual({
      success: false,
      text: "Invalid elizaOS action.",
    });
    const withArguments = await osCapabilityAction.handler?.(
      runtime,
      message(OWNER),
      undefined,
      { parameters: { action: "status", args: [] } } as never,
    );
    expect(withArguments).toEqual({
      success: false,
      text: "elizaOS capability actions do not accept arguments.",
    });
  });
});
