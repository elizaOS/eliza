import { describe, expect, it } from "vitest";
import {
  isCodexLandlockPanicExit,
  resolveCodexAcpCommand,
} from "../../src/services/codex-sandbox.js";

function setting(values: Record<string, string | undefined>) {
  return (key: string) => values[key];
}

describe("Codex ACP sandbox command resolution", () => {
  it("applies the no-Landlock fallback when Linux reports no Landlock LSM", () => {
    const resolved = resolveCodexAcpCommand("codex-acp --stdio", setting({}), {
      platform: "linux",
      readLinuxSecurityModules: () => "lockdown,yama,apparmor,bpf",
    });

    expect(resolved.command).toBe(
      'codex-acp --stdio -c sandbox_mode="danger-full-access" -c approval_policy="never"',
    );
    expect(resolved.landlockFallbackCommand).toBeUndefined();
    expect(resolved.noLandlockDetected).toBe(true);
    expect(resolved.sandboxMode).toBe("danger-full-access");
    expect(resolved.approvalPolicy).toBe("never");
  });

  it("uses explicit sandbox settings without waiting for Landlock detection", () => {
    const resolved = resolveCodexAcpCommand(
      "codex-acp --stdio",
      setting({
        ELIZA_CODEX_SANDBOX_MODE: "workspace-write",
        ELIZA_CODEX_APPROVAL_POLICY: "on-request",
      }),
      { platform: "linux", readLinuxSecurityModules: () => undefined },
    );

    expect(resolved.command).toBe(
      'codex-acp --stdio -c sandbox_mode="workspace-write" -c approval_policy="on-request"',
    );
    expect(resolved.landlockFallbackCommand).toBeUndefined();
    expect(resolved.noLandlockDetected).toBe(false);
  });

  it("arms a retry fallback when Landlock availability is unknown", () => {
    const resolved = resolveCodexAcpCommand("codex-acp --stdio", setting({}), {
      platform: "linux",
      readLinuxSecurityModules: () => undefined,
    });

    expect(resolved.command).toBe("codex-acp --stdio");
    expect(resolved.landlockFallbackCommand).toBe(
      'codex-acp --stdio -c sandbox_mode="danger-full-access" -c approval_policy="never"',
    );
    expect(resolved.noLandlockDetected).toBe(false);
  });

  it("does not duplicate sandbox args already present in the command", () => {
    const resolved = resolveCodexAcpCommand(
      'codex-acp --stdio -c sandbox_mode="read-only"',
      setting({}),
      {
        platform: "linux",
        readLinuxSecurityModules: () => "lockdown,yama,apparmor,bpf",
      },
    );

    expect(resolved.command).toBe(
      'codex-acp --stdio -c sandbox_mode="read-only"',
    );
    expect(resolved.landlockFallbackCommand).toBeUndefined();
  });

  it("recognizes the Codex Landlock panic signature", () => {
    expect(
      isCodexLandlockPanicExit({
        code: 101,
        stderr:
          "permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock",
      }),
    ).toBe(true);
    expect(
      isCodexLandlockPanicExit({
        code: 1,
        stderr:
          "permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock",
      }),
    ).toBe(false);
  });
});
