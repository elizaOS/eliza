import { describe, expect, it } from "vitest";

import {
  analyzePluginStateDrift,
  resolveAdvancedCapabilityCompatStatus,
  resolveCompatPluginEnabledForList,
} from "./plugins-compat-routes";

describe("analyzePluginStateDrift", () => {
  const pluginList: Parameters<typeof analyzePluginStateDrift>[0] = [
    {
      id: "discord",
      npmName: "@elizaos/plugin-discord",
      category: "connector",
      enabled: true,
      isActive: true,
    },
  ];

  const disabledPluginList: Parameters<typeof analyzePluginStateDrift>[0] = [
    {
      id: "discord",
      npmName: "@elizaos/plugin-discord",
      category: "connector",
      enabled: false,
      isActive: false,
    },
  ];

  const activeButDisabledPluginList: Parameters<
    typeof analyzePluginStateDrift
  >[0] = [
    {
      id: "discord",
      npmName: "@elizaos/plugin-discord",
      category: "connector",
      enabled: false,
      isActive: true,
    },
  ];

  it("reports no drift when entries, compat, allow-list, and runtime agree", () => {
    const report = analyzePluginStateDrift(
      pluginList,
      {
        connectors: {
          discord: { enabled: true },
        },
      },
      {
        discord: { enabled: true },
      },
      new Set(["@elizaos/plugin-discord", "discord"]),
    );

    expect(report.summary.withDrift).toBe(0);
    expect(report.summary.byFlag.entries_vs_compat).toBe(0);
    expect(report.summary.byFlag.entries_vs_allowlist).toBe(0);
    expect(report.summary.byFlag.inactive_but_enabled).toBe(0);
    expect(report.summary.byFlag.active_but_disabled).toBe(0);
    expect(report.plugins[0]?.drift_flags).toEqual([]);
  });

  it("flags entries_vs_compat when connector section diverges from entries", () => {
    const report = analyzePluginStateDrift(
      pluginList,
      {
        connectors: {
          discord: { enabled: false },
        },
      },
      {
        discord: { enabled: true },
      },
      new Set(["@elizaos/plugin-discord", "discord"]),
    );

    expect(report.summary.withDrift).toBe(1);
    expect(report.summary.byFlag.entries_vs_compat).toBe(1);
    expect(report.plugins[0]?.drift_flags).toContain("entries_vs_compat");
  });

  it("flags entries_vs_allowlist for optional core plugin drift", () => {
    const report = analyzePluginStateDrift(
      disabledPluginList,
      {
        connectors: {
          discord: { enabled: false },
        },
      },
      {
        discord: { enabled: true },
      },
      new Set<string>(),
    );

    expect(report.summary.withDrift).toBe(1);
    expect(report.summary.byFlag.entries_vs_allowlist).toBe(1);
    expect(report.plugins[0]?.drift_flags).toContain("entries_vs_allowlist");
  });

  it("skips entries_vs_allowlist when allow list is unconfigured (null)", () => {
    const report = analyzePluginStateDrift(
      pluginList,
      {
        connectors: {
          discord: { enabled: true },
        },
      },
      {
        discord: { enabled: true },
      },
      null,
    );

    expect(report.summary.withDrift).toBe(0);
    expect(report.summary.byFlag.entries_vs_allowlist).toBe(0);
    expect(report.plugins[0]?.enabled_allowlist).toBeNull();
  });

  it("flags active_but_disabled when runtime is active but UI model disabled", () => {
    const report = analyzePluginStateDrift(
      activeButDisabledPluginList,
      {
        connectors: {
          discord: { enabled: false },
        },
      },
      {
        discord: { enabled: false },
      },
      new Set<string>(),
    );

    expect(report.summary.withDrift).toBe(1);
    expect(report.summary.byFlag.active_but_disabled).toBe(1);
    expect(report.plugins[0]?.drift_flags).toContain("active_but_disabled");
  });

  it("treats experience as an advanced capability instead of a runtime plugin package", () => {
    const status = resolveAdvancedCapabilityCompatStatus(
      "experience",
      {
        plugins: {
          entries: {
            experience: { enabled: true },
          },
        },
      },
      {
        getService(serviceType: string) {
          return serviceType === "EXPERIENCE" ? { ok: true } : null;
        },
      },
    );

    expect(status).toEqual({ enabled: true, isActive: true });
  });

  it("uses explicit persisted disable over active runtime state in plugin list", () => {
    expect(resolveCompatPluginEnabledForList(true, false)).toBe(false);
  });
});
