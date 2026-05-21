import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Check, CheckResult } from "../types.js";
import { dirExists, readUtf8Safe } from "../util/fs.js";
import { walk } from "../util/fs.js";

function findDeployRoot(roots: string[]): string | null {
  for (const r of roots) {
    const p = join(r, "deploy");
    if (dirExists(p)) return p;
  }
  return null;
}

const WORKLOAD_KIND = /^kind:\s*(Deployment|StatefulSet|DaemonSet)\b/m;

export const k8sSecurityContext: Check = {
  id: "CC6.6-k8s-securitycontext",
  title:
    "All k8s workloads enforce runAsNonRoot, readOnlyRootFilesystem, and drop ALL capabilities",
  tsc: ["CC6.6", "CC6.8"],
  severity: "critical",
  async run(ctx): Promise<CheckResult> {
    const deployRoot = findDeployRoot([ctx.outerRoot, ctx.elizaRoot]);
    if (!deployRoot) {
      return {
        status: "fail",
        evidence: `No deploy/ directory found in either repo root.`,
      };
    }
    const files = await walk(deployRoot, {
      match: /\.ya?ml$/,
      maxDepth: 10,
    });
    const violations: string[] = [];
    let workloadCount = 0;
    for (const f of files) {
      const src = readUtf8Safe(f);
      if (!src) continue;
      // YAML may contain multiple docs; split on ^--- but inspect collectively.
      const docs = src.split(/^---\s*$/m);
      for (const doc of docs) {
        if (!WORKLOAD_KIND.test(doc)) continue;
        workloadCount++;
        const missing: string[] = [];
        if (!/runAsNonRoot:\s*true/.test(doc)) missing.push("runAsNonRoot=true");
        if (!/readOnlyRootFilesystem:\s*true/.test(doc))
          missing.push("readOnlyRootFilesystem=true");
        if (!/drop:\s*\n\s*-\s*['"]?ALL['"]?/.test(doc) && !/drop:\s*\[\s*['"]?ALL['"]?\s*\]/.test(doc))
          missing.push("capabilities.drop=[ALL]");
        if (missing.length > 0) violations.push(`${f}: ${missing.join(", ")}`);
      }
    }
    if (workloadCount === 0) {
      return {
        status: "warn",
        evidence: `No k8s workloads found under ${deployRoot}.`,
      };
    }
    return violations.length === 0
      ? {
          status: "pass",
          evidence: `${workloadCount} workloads checked; all enforce non-root + read-only root + capability drop.`,
        }
      : {
          status: "fail",
          evidence: `${violations.length}/${workloadCount} workloads violate securityContext requirements:\n${violations.slice(0, 20).join("\n")}${violations.length > 20 ? `\n…and ${violations.length - 20} more` : ""}`,
        };
  },
};

export const networkPoliciesPresent: Check = {
  id: "CC6.6-networkpolicies-present",
  title: "At least one NetworkPolicy manifest under deploy/k8s/networkpolicies/",
  tsc: ["CC6.6"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const candidates = [
      join(ctx.outerRoot, "deploy/k8s/networkpolicies"),
      join(ctx.elizaRoot, "deploy/k8s/networkpolicies"),
    ];
    for (const dir of candidates) {
      if (!dirExists(dir)) continue;
      const entries = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
      if (entries.length > 0) {
        return {
          status: "pass",
          evidence: `${entries.length} NetworkPolicy manifest(s) present in ${dir}.`,
          files: [dir],
        };
      }
    }
    return {
      status: "fail",
      evidence: `No NetworkPolicy manifests found in deploy/k8s/networkpolicies/.`,
    };
  },
};
