/**
 * SOC2 checks for ownership, branch-protection, and security-policy repository controls.
 */

import { join } from "node:path";
import type { Check, CheckResult } from "../types.js";
import { fileExists, readUtf8 } from "../util/fs.js";

const SENSITIVE_PATTERNS = [
  /cloud\/api/,
  /security/,
  /vault/,
  /deploy/,
  /install/i,
  /patches/,
];

export const codeownersPresent: Check = {
  id: "CC6.1-codeowners-present",
  title: "CODEOWNERS exists in both repo roots and covers sensitive paths",
  tsc: ["CC6.1", "CC6.3"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const candidates = [
      join(ctx.elizaRoot, ".github/CODEOWNERS"),
      join(ctx.outerRoot, ".github/CODEOWNERS"),
    ];
    const found = candidates.filter(fileExists);
    if (found.length === 0) {
      return {
        status: "fail",
        evidence: "No CODEOWNERS file found in either repo root.",
        files: candidates,
      };
    }
    const missingPaths: string[] = [];
    for (const path of found) {
      const contents = readUtf8(path);
      for (const pat of SENSITIVE_PATTERNS) {
        if (!pat.test(contents)) missingPaths.push(`${path}: missing ${pat}`);
      }
    }
    if (missingPaths.length > 0) {
      return {
        status: "warn",
        evidence: `CODEOWNERS present but missing coverage:\n${missingPaths.join("\n")}`,
        files: found,
      };
    }
    return {
      status: "pass",
      evidence: `CODEOWNERS files present and cover sensitive paths.`,
      files: found,
    };
  },
};

export const branchProtectionScript: Check = {
  id: "CC6.1-branch-protection-script-present",
  title: "Branch-protection setup script exists",
  tsc: ["CC6.1", "CC8.1"],
  severity: "medium",
  async run(ctx): Promise<CheckResult> {
    const candidates = [
      join(ctx.elizaRoot, "scripts/security/apply-branch-protection.sh"),
      join(ctx.outerRoot, "scripts/security/apply-branch-protection.sh"),
    ];
    const found = candidates.filter(fileExists);
    return found.length > 0
      ? {
          status: "pass",
          evidence: `Branch-protection script present.`,
          files: found,
        }
      : {
          status: "fail",
          evidence: `scripts/security/apply-branch-protection.sh missing in both repos.`,
          files: candidates,
        };
  },
};

export const securityMd: Check = {
  id: "CC9.2-security-md",
  title: "SECURITY.md references security@elizalabs.ai",
  tsc: ["CC2.2", "CC9.2"],
  severity: "medium",
  async run(ctx): Promise<CheckResult> {
    const candidates = [
      join(ctx.elizaRoot, "SECURITY.md"),
      join(ctx.outerRoot, "SECURITY.md"),
    ];
    const found = candidates.filter(fileExists);
    if (found.length === 0) {
      return {
        status: "fail",
        evidence: "SECURITY.md missing.",
        files: candidates,
      };
    }
    const refs = found.filter((p) =>
      /security@elizalabs\.ai/.test(readUtf8(p)),
    );
    return refs.length > 0
      ? {
          status: "pass",
          evidence: `SECURITY.md references security@elizalabs.ai.`,
          files: refs,
        }
      : {
          status: "warn",
          evidence: `SECURITY.md present but does not mention security@elizalabs.ai.`,
          files: found,
        };
  },
};
