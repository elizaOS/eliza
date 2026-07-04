/**
 * SOC2 checks for monitoring configuration and security alert-rule availability.
 */

import { join } from "node:path";
import type { Check, CheckResult } from "../types.js";
import { fileExists, readUtf8Safe } from "../util/fs.js";

function findIn(roots: string[], rel: string): string | null {
  for (const r of roots) {
    const p = join(r, rel);
    if (fileExists(p)) return p;
  }
  return null;
}

export const monitoringConfig: Check = {
  id: "CC7.1-monitoring-config",
  title:
    "OTel collector config exists and references Prometheus and Loki sinks",
  tsc: ["CC7.1", "A1.1"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const path = findIn(
      [ctx.outerRoot, ctx.elizaRoot],
      "deploy/observability/otel-collector-config.yaml",
    );
    if (!path) {
      return {
        status: "fail",
        evidence: `OTel collector config not found at deploy/observability/otel-collector-config.yaml.`,
      };
    }
    const src = readUtf8Safe(path) ?? "";
    const missing: string[] = [];
    if (!/prometheus/i.test(src)) missing.push("prometheus");
    if (!/loki/i.test(src)) missing.push("loki");
    return missing.length === 0
      ? {
          status: "pass",
          evidence: `Collector references prometheus and loki.`,
          files: [path],
        }
      : {
          status: "fail",
          evidence: `Collector at ${path} missing sinks: ${missing.join(", ")}.`,
          files: [path],
        };
  },
};

export const alertRulesPresent: Check = {
  id: "CC7.1-alert-rules-present",
  title: "Prometheus security alert rules present",
  tsc: ["CC7.1", "CC7.2"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const path = findIn(
      [ctx.outerRoot, ctx.elizaRoot],
      "deploy/observability/prometheus/alerts/security.yml",
    );
    return path
      ? {
          status: "pass",
          evidence: `Security alert rules present.`,
          files: [path],
        }
      : {
          status: "fail",
          evidence: `deploy/observability/prometheus/alerts/security.yml not found.`,
        };
  },
};
