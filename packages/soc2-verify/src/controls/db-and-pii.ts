import { join } from "node:path";
import type { Check, CheckResult } from "../types.js";
import { fileExists, readUtf8Safe } from "../util/fs.js";

export const dbSslmode: Check = {
  id: "CC6.7-db-sslmode",
  title: "DB client enforces sslmode=require for non-local connections",
  tsc: ["CC6.7"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const path = join(ctx.elizaRoot, "packages/cloud-shared/src/db/client.ts");
    const src = readUtf8Safe(path);
    if (!src) {
      return {
        status: "fail",
        evidence: `Missing ${path}`,
        files: [path],
      };
    }
    if (/sslmode\s*=\s*require/i.test(src)) {
      return {
        status: "pass",
        evidence: `sslmode=require referenced in db/client.ts.`,
        files: [path],
      };
    }
    return {
      status: "fail",
      evidence: `db/client.ts does not enforce sslmode=require. SOC2 CC6.7 requires TLS in transit for non-local DB connections.`,
      files: [path],
    };
  },
};

const ENCRYPTED_COLUMN_TARGETS: Array<{
  schemaFile: string;
  table: string;
  columns: string[];
}> = [
  {
    schemaFile: "packages/cloud-shared/src/db/schemas/users.ts",
    table: "users",
    columns: ["email", "phone_number", "wallet_address"],
  },
  {
    schemaFile: "packages/cloud-shared/src/db/schemas/platform-credentials.ts",
    table: "platform_credentials",
    columns: ["platform"],
  },
  {
    schemaFile: "packages/cloud-shared/src/db/schemas/conversations.ts",
    table: "conversations",
    columns: ["content"],
  },
];

export const piiEncryptionColumns: Check = {
  id: "C1.1-pii-encryption-columns",
  title: "Sensitive columns have ciphertext/nonce/auth_tag siblings",
  tsc: ["C1.1", "C1.2"],
  severity: "critical",
  async run(ctx): Promise<CheckResult> {
    const problems: string[] = [];
    const filesChecked: string[] = [];
    for (const target of ENCRYPTED_COLUMN_TARGETS) {
      const path = join(ctx.elizaRoot, target.schemaFile);
      const src = readUtf8Safe(path);
      filesChecked.push(path);
      if (!src) {
        problems.push(`${target.schemaFile}: file missing`);
        continue;
      }
      for (const col of target.columns) {
        // ciphertext column is the minimal evidence; nonce/auth_tag are checked too.
        const checks = [
          new RegExp(`${col}_ciphertext`),
          new RegExp(`${col}_nonce`),
          new RegExp(`${col}_auth_tag`),
        ];
        const missing = checks.filter((r) => !r.test(src));
        if (missing.length > 0) {
          problems.push(
            `${target.table}.${col}: missing ${missing.map((r) => r.source).join(", ")}`,
          );
        }
      }
    }
    return problems.length === 0
      ? {
          status: "pass",
          evidence: `All inspected sensitive columns have ciphertext/nonce/auth_tag siblings.`,
          files: filesChecked,
        }
      : {
          status: "fail",
          evidence: `Encryption-column siblings missing:\n${problems.join("\n")}`,
          files: filesChecked,
        };
  },
};

const SOFT_DELETE_TARGETS = [
  { file: "packages/cloud-shared/src/db/schemas/users.ts", table: "users" },
  {
    file: "packages/cloud-shared/src/db/schemas/conversations.ts",
    table: "conversations",
  },
  {
    file: "packages/cloud-shared/src/db/schemas/api-keys.ts",
    table: "api_keys",
  },
  {
    file: "packages/cloud-shared/src/db/schemas/secrets.ts",
    table: "secrets",
  },
  {
    file: "packages/cloud-shared/src/db/schemas/agents.ts",
    table: "agents",
  },
  {
    file: "packages/cloud-shared/src/db/schemas/connector-accounts.ts",
    table: "connector_accounts",
  },
];

export const softDeleteColumns: Check = {
  id: "C1.2-soft-delete-columns",
  title: "Sensitive tables expose deleted_at for soft-delete / DSR",
  tsc: ["C1.2", "P5.1"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const problems: string[] = [];
    const filesChecked: string[] = [];
    for (const t of SOFT_DELETE_TARGETS) {
      const path = join(ctx.elizaRoot, t.file);
      filesChecked.push(path);
      const src = readUtf8Safe(path);
      if (!src) {
        problems.push(`${t.table}: schema file missing (${t.file})`);
        continue;
      }
      if (!/deleted_at/.test(src)) {
        problems.push(`${t.table}: no deleted_at column`);
      }
    }
    return problems.length === 0
      ? {
          status: "pass",
          evidence: `All targeted tables have deleted_at.`,
          files: filesChecked,
        }
      : {
          status: "fail",
          evidence: `Soft-delete columns missing:\n${problems.join("\n")}`,
          files: filesChecked,
        };
  },
};

export const auditLogRetention: Check = {
  id: "C1.2-audit-log-retention",
  title: "Audit/auth-event tables expose expires_at for retention enforcement",
  tsc: ["C1.2", "CC4.1"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const targets = [
      {
        file: "packages/cloud-shared/src/db/schemas/secret-audit-log.ts",
        table: "secret_audit_log",
      },
      {
        file: "packages/cloud-shared/src/db/schemas/auth-events.ts",
        table: "auth_events",
      },
    ];
    const problems: string[] = [];
    const files: string[] = [];
    for (const t of targets) {
      const p = join(ctx.elizaRoot, t.file);
      files.push(p);
      const src = readUtf8Safe(p);
      if (!src) {
        problems.push(`${t.table}: schema file missing (${t.file})`);
        continue;
      }
      if (!/expires_at/.test(src)) {
        problems.push(`${t.table}: no expires_at column`);
      }
    }
    return problems.length === 0
      ? {
          status: "pass",
          evidence: `Retention column present on audit tables.`,
          files,
        }
      : {
          status: "fail",
          evidence: `Audit retention columns missing:\n${problems.join("\n")}`,
          files,
        };
  },
};

export const kmsAdoption: Check = {
  id: "C1.1-kms-adoption",
  title: "@elizaos/security imported across cloud-shared, cloud-api, agent, app",
  tsc: ["C1.1", "CC6.1"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const targets = [
      "packages/cloud-shared",
      "packages/cloud-api",
      "packages/agent",
      "apps/app",
    ];
    const { walk } = await import("../util/fs.js");
    const problems: string[] = [];
    const evidence: string[] = [];
    for (const t of targets) {
      const root = join(ctx.elizaRoot, t);
      if (!fileExists(join(root, "package.json"))) {
        problems.push(`${t}: directory not present`);
        continue;
      }
      const files = await walk(root, {
        match: /\.(ts|tsx|mts|cts|js|mjs|cjs)$/,
        maxDepth: 8,
      });
      let count = 0;
      for (const f of files) {
        const src = readUtf8Safe(f);
        if (!src) continue;
        if (/from\s+["']@elizaos\/security["']/.test(src)) {
          count++;
        }
      }
      if (count === 0) {
        problems.push(`${t}: no @elizaos/security imports found`);
      } else {
        evidence.push(`${t}: ${count} import(s)`);
      }
    }
    return problems.length === 0
      ? {
          status: "pass",
          evidence: evidence.join("; "),
          files: targets.map((t) => join(ctx.elizaRoot, t)),
        }
      : {
          status: "fail",
          evidence: `Missing @elizaos/security adoption:\n${problems.join("\n")}\nFound:\n${evidence.join("\n")}`,
          files: targets.map((t) => join(ctx.elizaRoot, t)),
        };
  },
};
