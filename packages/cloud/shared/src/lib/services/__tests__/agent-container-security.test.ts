/**
 * Tests the hosted-agent Docker security-flag builder as a pure command
 * contract, including the ordering required when Headscale re-adds NET_ADMIN.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentCpuUnitsToDockerCpus,
  buildAgentContainerCpuFlags,
  buildAgentContainerMemoryFlags,
  buildAgentContainerSecurityFlags,
  buildAgentContainerUserFlags,
  buildPrepareAgentRuntimeVolumesCmd,
} from "../agent-container-security";
import {
  buildEnsureHostedAgentAppArmorProfileCmd,
  HOSTED_AGENT_BWRAP_APPARMOR_PROFILE,
  HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_NAME,
  HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_PATH,
  HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_SHA256,
} from "../hosted-agent-apparmor-profile";
import { HOSTED_AGENT_POLICY_ROOT_REQUIREMENT } from "../hosted-agent-root-command";
import {
  buildEnsureHostedAgentSeccompProfileCmd,
  HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_JSON,
  HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_PATH,
  HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_SHA256,
} from "../hosted-agent-seccomp-profile";

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

describe("buildAgentContainerSecurityFlags — hosted-agent escape hardening (#12468)", () => {
  test("always drops all caps, forbids priv-escalation, and bounds pids (default 512)", () => {
    const flags = buildAgentContainerSecurityFlags({ headscaleEnabled: false });
    const cmd = flags.join(" ");
    expect(flags).toContain("--cap-drop=ALL");
    expect(cmd).toContain("--security-opt no-new-privileges");
    expect(cmd).toContain(`--security-opt seccomp='${HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_PATH}'`);
    expect(cmd).toContain(`--security-opt apparmor='${HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_NAME}'`);
    expect(flags).toContain("--pids-limit=512");
    expect(cmd).not.toContain("seccomp=unconfined");
    expect(cmd).not.toContain("apparmor=unconfined");
    expect(cmd).not.toContain("CAP_SYS_ADMIN");
  });

  test("without headscale, keeps cap-drop=ALL and starts as the runtime uid", () => {
    const cmd = buildAgentContainerSecurityFlags({ headscaleEnabled: false }).join(" ");
    expect(cmd).not.toContain("--cap-add");
    expect(cmd).not.toContain("NET_ADMIN");
    expect(cmd).not.toContain("/dev/net/tun");
    expect(cmd).not.toContain("SYS_ADMIN");
    expect(buildAgentContainerUserFlags({ headscaleEnabled: false })).toEqual([
      "--user 10001:10001",
    ]);
  });

  test("under headscale, adds NET_ADMIN + tun after the bootstrap caps", () => {
    const flags = buildAgentContainerSecurityFlags({ headscaleEnabled: true });
    const cmd = flags.join(" ");
    // Hardening still present...
    expect(flags).toContain("--cap-drop=ALL");
    expect(cmd).toContain("--security-opt no-new-privileges");
    expect(flags).toContain("--pids-limit=512");
    // ...and only the setuid transition plus tailnet capability/device are re-added.
    expect(flags).toContain("--cap-add=SETUID");
    expect(flags).toContain("--cap-add=SETGID");
    expect(flags).toContain("--cap-add=NET_ADMIN");
    expect(flags).toContain("--device /dev/net/tun");
    expect(flags).not.toContain("--cap-add=CHOWN");
    expect(buildAgentContainerUserFlags({ headscaleEnabled: true })).toEqual([]);
  });

  test("ORDER: --cap-drop=ALL is emitted BEFORE --cap-add=NET_ADMIN (drop-all-then-re-add idiom)", () => {
    const flags = buildAgentContainerSecurityFlags({ headscaleEnabled: true });
    const dropIdx = flags.indexOf("--cap-drop=ALL");
    const addIdx = flags.indexOf("--cap-add=NET_ADMIN");
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    // A cap-add BEFORE the ALL drop would be wiped out, leaving the container
    // with no NET_ADMIN — the tun interface would fail to come up. Guard it.
    expect(dropIdx).toBeLessThan(addIdx);
  });

  test("honors a custom pids-limit override", () => {
    expect(buildAgentContainerSecurityFlags({ headscaleEnabled: true, pidsLimit: 1024 })).toContain(
      "--pids-limit=1024",
    );
  });

  test("prepares only a validated per-agent host volume for uid 10001", () => {
    const command = buildPrepareAgentRuntimeVolumesCmd("/data/agents/agent-123");
    expect(command).toContain("install -d -m 0750 -o 10001 -g 10001");
    expect(command).toContain("chown -hR 10001:10001");
    expect(command).toContain("/data/agents/agent-123/eliza");
    expect(() => buildPrepareAgentRuntimeVolumesCmd("/data/agents/../shared")).toThrow(
      "validated per-agent path",
    );
    expect(() => buildPrepareAgentRuntimeVolumesCmd("/")).toThrow("validated per-agent path");
  });
});

describe("hosted-agent bubblewrap seccomp profile", () => {
  test("keeps Docker's deny-by-default profile and opens only the namespace setup bubblewrap needs", () => {
    const profile = JSON.parse(HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_JSON) as {
      defaultAction: string;
      syscalls: Array<{
        names: string[];
        action: string;
        args?: Array<{ index: number; value: number; valueTwo?: number; op: string }>;
        includes?: { caps?: string[] };
      }>;
    };

    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(profile.syscalls.some((rule) => rule.names.includes("socketcall"))).toBe(false);
    expect(
      profile.syscalls
        .filter((rule) => rule.names.length === 1 && rule.names[0] === "socket")
        .map((rule) => rule.args?.[0]),
    ).toEqual([
      { index: 0, value: 38, op: "SCMP_CMP_LT" },
      { index: 0, value: 39, op: "SCMP_CMP_EQ" },
      { index: 0, value: 40, op: "SCMP_CMP_GT" },
    ]);
    const unconditional = profile.syscalls.filter(
      (rule) => rule.action === "SCMP_ACT_ALLOW" && !rule.args && !rule.includes,
    );
    expect(unconditional.some((rule) => rule.names.includes("setns"))).toBe(false);
    expect(unconditional.some((rule) => rule.names.includes("clone3"))).toBe(false);
    expect(unconditional.flatMap((rule) => rule.names)).toEqual(
      expect.arrayContaining(["mount", "pivot_root", "sethostname", "umount2"]),
    );

    const cloneRule = profile.syscalls.find(
      (rule) =>
        rule.names.length === 1 &&
        rule.names[0] === "clone" &&
        rule.args?.[0]?.valueTwo === 268566528,
    );
    expect(cloneRule?.args?.[0]).toMatchObject({
      index: 0,
      value: 268566528,
      valueTwo: 268566528,
      op: "SCMP_CMP_MASKED_EQ",
    });

    const unshareRule = profile.syscalls.find(
      (rule) => rule.names.length === 1 && rule.names[0] === "unshare" && rule.args,
    );
    expect(unshareRule?.args).toEqual([{ index: 0, value: 268435456, op: "SCMP_CMP_EQ" }]);
  });

  test("pins the canonical payload checksum and installs it atomically with mode 0644", () => {
    expect(createHash("sha256").update(HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_JSON).digest("hex")).toBe(
      HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_SHA256,
    );

    const fixture = mkdtempSync(join(tmpdir(), "eliza-agent-seccomp-"));
    const profilePath = join(fixture, "profiles", "hosted-agent.json");
    try {
      const binDir = join(fixture, "bin");
      mkdirSync(binDir);
      // Exercise the root branch without requiring the test runner itself to
      // be privileged; the installer target remains inside this fixture.
      writeExecutable(join(binDir, "id"), "#!/bin/sh\nprintf '0\\n'\n");
      const command = buildEnsureHostedAgentSeccompProfileCmd(profilePath);
      expect(command).not.toMatch(/[\r\n]/);
      execFileSync("/bin/sh", ["-c", command], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
        stdio: "pipe",
      });
      expect(readFileSync(profilePath, "utf8")).toBe(HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_JSON);
      expect(statSync(profilePath).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("a non-root Docker user installs through passwordless sudo instead of failing later", () => {
    const fixture = mkdtempSync(join(tmpdir(), "eliza-agent-seccomp-sudo-"));
    const binDir = join(fixture, "bin");
    const profilePath = join(fixture, "profiles", "hosted-agent.json");
    const sudoLog = join(fixture, "sudo.log");
    try {
      mkdirSync(binDir);
      writeExecutable(join(binDir, "id"), "#!/bin/sh\nprintf '1000\\n'\n");
      writeExecutable(
        join(binDir, "sudo"),
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_SUDO_LOG"\n[ "$1" = "-n" ] || exit 97\nshift\nexec "$@"\n',
      );

      execFileSync("/bin/sh", ["-c", buildEnsureHostedAgentSeccompProfileCmd(profilePath)], {
        env: {
          ...process.env,
          FAKE_SUDO_LOG: sudoLog,
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        },
        stdio: "pipe",
      });

      expect(readFileSync(sudoLog, "utf8")).toContain("-n /bin/sh -c");
      expect(readFileSync(profilePath, "utf8")).toBe(HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_JSON);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("a non-root Docker-only user fails with an explicit onboarding requirement", () => {
    const fixture = mkdtempSync(join(tmpdir(), "eliza-agent-seccomp-no-sudo-"));
    const binDir = join(fixture, "bin");
    try {
      mkdirSync(binDir);
      writeExecutable(join(binDir, "id"), "#!/bin/sh\nprintf '1000\\n'\n");
      let stderr = "";
      try {
        execFileSync(
          "/bin/sh",
          ["-c", buildEnsureHostedAgentSeccompProfileCmd(join(fixture, "profile.json"))],
          { env: { ...process.env, PATH: binDir }, stdio: "pipe" },
        );
      } catch (error) {
        stderr = String((error as { stderr?: Buffer }).stderr ?? error);
      }
      expect(stderr).toContain(HOSTED_AGENT_POLICY_ROOT_REQUIREMENT);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("hosted-agent bubblewrap AppArmor profile", () => {
  test("is the checked-in enforcing Moby-derived policy with only bwrap's mount setup delta", () => {
    const checkedInProfile = readFileSync(
      new URL("../hosted-agent-bwrap.apparmor", import.meta.url),
      "utf8",
    );

    expect(checkedInProfile).toBe(HOSTED_AGENT_BWRAP_APPARMOR_PROFILE);
    expect(createHash("sha256").update(checkedInProfile).digest("hex")).toBe(
      HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_SHA256,
    );
    expect(checkedInProfile).toContain(
      `profile "${HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_NAME}" flags=(attach_disconnected,mediate_deleted)`,
    );
    expect(checkedInProfile).toContain("\n  mount,\n");
    expect(checkedInProfile).toContain("\n  pivot_root,\n");
    expect(checkedInProfile).toContain("\n  umount,\n");
    expect(checkedInProfile).not.toContain("deny mount");
    expect(checkedInProfile).toContain("deny network alg");
    expect(checkedInProfile).toContain("deny /sys/kernel/security/** rwklx");
    expect(checkedInProfile).toContain("@{PROC}/sys/user/max_user_namespaces w,");
    expect(checkedInProfile).toContain(
      "deny @{PROC}/sys/user/max_{cgroup,ipc,mnt,net,pid,time,uts}_namespaces w,",
    );
    expect(checkedInProfile).not.toMatch(/flags=\([^)]*(?:complain|unconfined)/);
  });

  test("installs atomically, loads with replacement semantics, and verifies enforce mode", () => {
    const command = buildEnsureHostedAgentAppArmorProfileCmd();
    expect(command).not.toMatch(/[\r\n]/);
    expect(command).toContain(HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_PATH);
    expect(command).toContain(HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_SHA256);
    expect(command).toContain("apparmor_parser -Kr");
    expect(command).toContain(`${HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_NAME} (enforce)`);
    expect(command).not.toContain("apparmor=unconfined");
    expect(command).not.toContain("complain");
  });
});

describe("buildAgentContainerMemoryFlags — per-agent OOM containment (staging fleet incident 2026-08-05)", () => {
  test("emits --memory AND a matching --memory-swap (no swap escape) for a positive limit", () => {
    expect(buildAgentContainerMemoryFlags(3072)).toEqual([
      "--memory '3072m'",
      "--memory-swap '3072m'",
    ]);
  });

  test("ceils fractional MiB so the swap pin never undershoots the memory flag", () => {
    expect(buildAgentContainerMemoryFlags(1536.2)).toEqual([
      "--memory '1537m'",
      "--memory-swap '1537m'",
    ]);
  });

  test("0 disables the ceiling entirely (no flags — the explicit opt-out)", () => {
    expect(buildAgentContainerMemoryFlags(0)).toEqual([]);
  });

  test("undefined / negative / NaN emit no flags rather than a garbage docker arg", () => {
    expect(buildAgentContainerMemoryFlags(undefined)).toEqual([]);
    expect(buildAgentContainerMemoryFlags(-512)).toEqual([]);
    expect(buildAgentContainerMemoryFlags(Number.NaN)).toEqual([]);
  });
});

describe("buildAgentContainerCpuFlags — per-agent CPU containment for robot density (#18485)", () => {
  test("emits a quoted --cpus quota for a positive limit", () => {
    expect(buildAgentContainerCpuFlags(2)).toEqual(["--cpus '2'"]);
  });

  test("keeps fractional cores to two decimals — valid docker input, no float noise", () => {
    expect(buildAgentContainerCpuFlags(1.5)).toEqual(["--cpus '1.5'"]);
    expect(buildAgentContainerCpuFlags(0.333333)).toEqual(["--cpus '0.33'"]);
  });

  test("0 disables the quota entirely (no flags — the explicit opt-out)", () => {
    expect(buildAgentContainerCpuFlags(0)).toEqual([]);
  });

  test("undefined / negative / NaN emit no flags rather than a garbage docker arg", () => {
    expect(buildAgentContainerCpuFlags(undefined)).toEqual([]);
    expect(buildAgentContainerCpuFlags(-1)).toEqual([]);
    expect(buildAgentContainerCpuFlags(Number.NaN)).toEqual([]);
  });
});

describe("agentCpuUnitsToDockerCpus", () => {
  test("converts the persisted ECS-style unit contract before building Docker flags", () => {
    expect(agentCpuUnitsToDockerCpus(512)).toBe(0.5);
    expect(agentCpuUnitsToDockerCpus(1024)).toBe(1);
    expect(buildAgentContainerCpuFlags(agentCpuUnitsToDockerCpus(2048))).toEqual(["--cpus '2'"]);
  });

  test("rejects invalid unit values", () => {
    expect(agentCpuUnitsToDockerCpus(undefined)).toBeUndefined();
    expect(agentCpuUnitsToDockerCpus(0)).toBeUndefined();
    expect(agentCpuUnitsToDockerCpus(Number.NaN)).toBeUndefined();
  });
});
