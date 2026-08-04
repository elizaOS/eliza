/**
 * Codex ACP bootstrap command contract, including project-manifest isolation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { splitCommandLine } from "../services/acp-native-transport.js";
import {
  AcpService,
  defaultCodexAcpCommand,
  resolveCodexAcpCommand,
  resolveCodexAcpInitialAgentMode,
} from "../services/acp-service.js";
import { resolveCodexNoLandlockSandboxMode } from "../services/codex-sandbox.js";

describe("defaultCodexAcpCommand", () => {
  it("uses an isolated npm prefix even when the temp path contains spaces", () => {
    const parsed = splitCommandLine(
      defaultCodexAcpCommand("/tmp/eliza coding agent"),
    );

    expect(parsed).toEqual({
      command: "npx",
      args: [
        "-y",
        "--prefix",
        "/tmp/eliza coding agent",
        "--package=@agentclientprotocol/codex-acp@1.1.2",
        "--",
        "codex-acp",
      ],
    });
  });

  it("maps successor sandbox settings to its fixed ACP modes", () => {
    expect(resolveCodexAcpInitialAgentMode("read-only", "on-request")).toBe(
      "read-only",
    );
    expect(resolveCodexAcpInitialAgentMode("workspace-write")).toBe("agent");
    expect(resolveCodexAcpInitialAgentMode("danger-full-access", "never")).toBe(
      "agent-full-access",
    );
  });

  it("rejects approval settings the successor mode cannot honor", () => {
    expect(() =>
      resolveCodexAcpInitialAgentMode("workspace-write", "never"),
    ).toThrow("requires approval policy on-request");
  });

  it("never widens a coding session to host access without operator opt-in", () => {
    expect(resolveCodexNoLandlockSandboxMode(undefined)).toBeUndefined();
    expect(resolveCodexNoLandlockSandboxMode("")).toBeUndefined();
    expect(resolveCodexNoLandlockSandboxMode("not-a-mode")).toBeUndefined();
    expect(resolveCodexNoLandlockSandboxMode("workspace-write")).toBe(
      "workspace-write",
    );
    expect(resolveCodexNoLandlockSandboxMode("danger-full-access")).toBe(
      "danger-full-access",
    );
  });

  it("fails the real Codex spawn path closed when Landlock is unavailable", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-sandbox-"));
    const runtime = {
      agentId: "00000000-0000-4000-8000-00000000c0de",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getSetting: (key: string) => {
        if (key === "ELIZA_ACP_TRANSPORT") return "native";
        if (key === "ELIZA_CODEX_ACP_LANDLOCK") return "false";
        return undefined;
      },
    } as unknown as IAgentRuntime;
    const service = new AcpService(runtime);
    try {
      await service.start();
      await expect(
        service.spawnSession({
          agentType: "codex",
          workdir,
          approvalPreset: "autonomous",
        }),
      ).rejects.toThrow(/refusing to widen this coding session to host access/);
    } finally {
      await service.stop().catch(() => undefined);
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("removes command-breaking quotes and newlines from the temp path", () => {
    const parsed = splitCommandLine(defaultCodexAcpCommand('/tmp/a"b\nc'));

    expect(parsed.args[2]).toBe("/tmp/abc");
  });

  it("upgrades the plugin manifest default but preserves operator commands", () => {
    const isolated = defaultCodexAcpCommand("/tmp/isolated");

    expect(
      resolveCodexAcpCommand(
        "npx -y @zed-industries/codex-acp@0.14.0",
        isolated,
      ),
    ).toBe(isolated);
    expect(
      resolveCodexAcpCommand(
        "npx -y @agentclientprotocol/codex-acp@1.1.2",
        isolated,
      ),
    ).toBe(isolated);
    expect(
      resolveCodexAcpCommand(
        '  custom-codex-acp --mode "operator owned"  ',
        isolated,
      ),
    ).toBe('  custom-codex-acp --mode "operator owned"  ');
  });
});
