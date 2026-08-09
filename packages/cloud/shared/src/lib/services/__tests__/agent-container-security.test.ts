/**
 * Tests the hosted-agent Docker security-flag builder as a pure command
 * contract, including the ordering required when Headscale re-adds NET_ADMIN.
 */

import { describe, expect, test } from "bun:test";

import {
  buildAgentContainerMemoryFlags,
  buildAgentContainerSecurityFlags,
} from "../agent-container-security";

describe("buildAgentContainerSecurityFlags — hosted-agent escape hardening (#12468)", () => {
  test("always drops all caps, forbids priv-escalation, and bounds pids (default 512)", () => {
    const flags = buildAgentContainerSecurityFlags({ headscaleEnabled: false });
    const cmd = flags.join(" ");
    expect(flags).toContain("--cap-drop=ALL");
    expect(cmd).toContain("--security-opt no-new-privileges");
    expect(flags).toContain("--pids-limit=512");
  });

  test("without headscale, adds NO NET_ADMIN and NO tun device (agent-only escapes stay off)", () => {
    const cmd = buildAgentContainerSecurityFlags({ headscaleEnabled: false }).join(" ");
    expect(cmd).not.toContain("NET_ADMIN");
    expect(cmd).not.toContain("/dev/net/tun");
  });

  test("under headscale, re-adds exactly NET_ADMIN + the tun device on top of the hardening", () => {
    const flags = buildAgentContainerSecurityFlags({ headscaleEnabled: true });
    const cmd = flags.join(" ");
    // Hardening still present...
    expect(flags).toContain("--cap-drop=ALL");
    expect(cmd).toContain("--security-opt no-new-privileges");
    expect(flags).toContain("--pids-limit=512");
    // ...and the single legitimately-needed capability + device are re-added.
    expect(flags).toContain("--cap-add=NET_ADMIN");
    expect(flags).toContain("--device /dev/net/tun");
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
