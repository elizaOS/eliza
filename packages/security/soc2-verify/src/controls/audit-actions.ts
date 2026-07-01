import { join } from "node:path";
import type { Check, CheckResult } from "../types.js";
import { readUtf8Safe } from "../util/fs.js";

const REQUIRED_ACTIONS = [
  "auth.login",
  "auth.logout",
  "api_key.create",
  "api_key.revoke",
  "api_key.use",
  "plugin.install",
  "plugin.grant",
  "plugin.revoke",
  "agent.spawn",
  "data.export",
  "data.delete_request",
  "secret.access",
  "admin.action",
];

export const auditActionsComprehensive: Check = {
  id: "CC4.1-audit-actions-comprehensive",
  title: "AUDIT_ACTIONS includes every mandatory action name",
  tsc: ["CC4.1", "CC7.2"],
  severity: "critical",
  async run(ctx): Promise<CheckResult> {
    const path = join(ctx.elizaRoot, "packages/security/src/audit/actions.ts");
    const src = readUtf8Safe(path);
    if (!src) {
      return {
        status: "fail",
        evidence: `Missing ${path}`,
        files: [path],
      };
    }
    const missing = REQUIRED_ACTIONS.filter(
      (a) => !new RegExp(`["']${a.replace(/\./g, "\\.")}["']`).test(src),
    );
    return missing.length === 0
      ? {
          status: "pass",
          evidence: `All ${REQUIRED_ACTIONS.length} mandatory audit actions defined.`,
          files: [path],
        }
      : {
          status: "fail",
          evidence: `Missing audit actions: ${missing.join(", ")}`,
          files: [path],
        };
  },
};
