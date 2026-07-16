/**
 * Codex ACP bootstrap command contract, including project-manifest isolation.
 */

import { describe, expect, it } from "vitest";
import { splitCommandLine } from "../services/acp-native-transport.js";
import {
  defaultCodexAcpCommand,
  resolveCodexAcpCommand,
  resolveCodexAcpInitialAgentMode,
} from "../services/acp-service.js";

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
