import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import {
  ALLOWED_NON_RUNTIME_CHANGES,
  admitProductionHyperdriveBindingFromGit,
  PINNED_EXISTING_MAIN_TRANSITIONS,
  TRUSTED_POLICY_PATHS,
  validateProductionHyperdriveAuthority,
  validateProductionHyperdriveBindingDelta,
  validateTrustedPolicyIdentityFromGit,
  WRANGLER_PATH,
} from "./production-hyperdrive-binding-admission.mjs";

const oldId = "1".repeat(32);
const newId = "2".repeat(32);
const repoRoot = resolve(import.meta.dirname, "../../..");
const policyFixtureSha = execFileSync(
  "git",
  ["-C", repoRoot, "rev-parse", "HEAD"],
  {
    encoding: "utf8",
  },
).trim();
const prePolicyFixtureSha = execFileSync(
  "git",
  ["-C", repoRoot, "rev-parse", "HEAD^"],
  { encoding: "utf8" },
).trim();

function config(id = oldId, extra = "") {
  return `name = "cloud"\n${extra}\n[env.production]\nname = "cloud-production"\n[[env.production.hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "${id}"\n\n[env.staging]\nname = "cloud-staging"\n[[env.staging.hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "${"3".repeat(32)}"\n`;
}

function valid(overrides = {}) {
  return {
    baseWranglerSource: config(oldId),
    candidateWranglerSource: config(newId),
    changes: [{ status: "M", path: WRANGLER_PATH }],
    force: false,
    ...overrides,
  };
}

describe("production Hyperdrive binding-only admission", () => {
  test("accepts exactly one production binding id replacement", () => {
    expect(validateProductionHyperdriveBindingDelta(valid())).toMatchObject({
      schemaVersion: 1,
      verdict: "pass",
      changedPathCount: 1,
    });
  });

  test("accepts only the explicitly classified non-runtime policy files", () => {
    const changes = [
      { status: "M", path: WRANGLER_PATH },
      ...[...ALLOWED_NON_RUNTIME_CHANGES].map(([path, statuses]) => ({
        path,
        status: statuses.has("A") ? "A" : "M",
      })),
    ];
    expect(
      validateProductionHyperdriveBindingDelta(valid({ changes })),
    ).toMatchObject({ verdict: "pass", changedPathCount: changes.length });
  });

  test("pins the two unrelated workflow/test transitions already reviewed on main", () => {
    expect([...PINNED_EXISTING_MAIN_TRANSITIONS]).toEqual([
      [
        ".github/workflows/deploy-eliza-provisioning-worker.yml",
        [
          "ca21ddcc79058357594872fc60cbf4bc64adbd3a",
          "9e8ecb1f91fdb6db79b8e6c6a5588509804c12c5",
        ],
      ],
      [
        "packages/scripts/__tests__/provisioning-worker-deploy-workflow.test.ts",
        [
          "2cfd3cf834dae09bb285b9292928f906602181fc",
          "f0f54a609f8e918a59b9adfbcc24c6e2cebd18e7",
        ],
      ],
    ]);
  });

  test("admits the reviewed production binding commit from its served base", () => {
    expect(
      admitProductionHyperdriveBindingFromGit({
        repoRoot,
        baseSha: "c0a8de04019f62a96c5f6bf21ee7c15ee554cafe",
        candidateSha: "579d546d2d23c954c0aef9775356781e674cb689",
        force: false,
      }),
    ).toMatchObject({ verdict: "pass", changedPathCount: 3 });
  });

  test("requires all production policy blobs to equal the trusted develop policy", () => {
    expect(
      validateTrustedPolicyIdentityFromGit({
        repoRoot,
        policySha: policyFixtureSha,
        candidateSha: policyFixtureSha,
      }),
    ).toEqual({
      schemaVersion: 1,
      verdict: "pass",
      policyPathCount: TRUSTED_POLICY_PATHS.length,
    });
  });

  test("rejects a candidate missing the trusted policy blobs", () => {
    expect(() =>
      validateTrustedPolicyIdentityFromGit({
        repoRoot,
        policySha: policyFixtureSha,
        candidateSha: prePolicyFixtureSha,
      }),
    ).toThrow(/production_hyperdrive_binding_admission/);
  });

  test.each([
    ["force", { force: true }],
    ["missing changes", { changes: [] }],
    [
      "duplicate path",
      {
        changes: [
          { status: "M", path: WRANGLER_PATH },
          { status: "M", path: WRANGLER_PATH },
        ],
      },
    ],
    [
      "code path",
      { changes: [{ status: "M", path: "packages/cloud/api/src/index.ts" }] },
    ],
    [
      "migration",
      {
        changes: [
          {
            status: "A",
            path: "packages/cloud/shared/src/db/migrations/9999.sql",
          },
        ],
      },
    ],
    ["deleted Wrangler", { changes: [{ status: "D", path: WRANGLER_PATH }] }],
    ["unchanged id", { candidateWranglerSource: config(oldId) }],
    [
      "staging mutation",
      {
        candidateWranglerSource: config(newId).replace(
          "3".repeat(32),
          "4".repeat(32),
        ),
      },
    ],
    [
      "general Wrangler mutation",
      {
        candidateWranglerSource: config(
          newId,
          'compatibility_date = "2099-01-01"',
        ),
      },
    ],
    [
      "comment-only Wrangler mutation",
      {
        candidateWranglerSource: `${config(newId)}# forbidden textual drift\n`,
      },
    ],
    [
      "duplicate candidate id token",
      {
        candidateWranglerSource: `${config(newId)}# ${newId}\n`,
      },
    ],
    ["malformed TOML", { candidateWranglerSource: "[env.production" }],
    [
      "multiple bindings",
      {
        candidateWranglerSource: `${config(newId)}\n[[env.production.hyperdrive]]\nbinding = "SECOND"\nid = "${"5".repeat(32)}"\n`,
      },
    ],
    [
      "extra binding field",
      {
        candidateWranglerSource: config(newId).replace(
          `id = "${newId}"`,
          `id = "${newId}"\nlocalConnectionString = "forbidden"`,
        ),
      },
    ],
    ["uppercase id", { candidateWranglerSource: config("A".repeat(32)) }],
  ])("rejects %s", (_label, overrides) => {
    expect(() =>
      validateProductionHyperdriveBindingDelta(valid(overrides)),
    ).toThrow(/production_hyperdrive_binding_admission/);
  });
});

describe("production Hyperdrive authority", () => {
  const expectedConfigId = "2".repeat(32);
  const response = {
    success: true,
    result: {
      id: expectedConfigId,
      origin: {
        host: "db.example.invalid",
        port: 36497,
        database: "railway",
        user: "postgres",
        scheme: "postgresql",
      },
    },
  };

  test("accepts exact protected URL and Hyperdrive origin equality", () => {
    expect(
      validateProductionHyperdriveAuthority({
        response,
        expectedConfigId,
        databaseUrl:
          "postgresql://postgres:secret@db.example.invalid:36497/railway?sslmode=require",
      }),
    ).toMatchObject({
      schemaVersion: 1,
      verdict: "pass",
      authorityReceipt: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test.each([
    ["response failure", { response: { ...response, success: false } }],
    ["wrong config", { expectedConfigId: "4".repeat(32) }],
    [
      "wrong host",
      {
        databaseUrl: "postgresql://postgres:secret@other.invalid:36497/railway",
      },
    ],
    [
      "wrong port",
      {
        databaseUrl:
          "postgresql://postgres:secret@db.example.invalid:5432/railway",
      },
    ],
    [
      "wrong database",
      {
        databaseUrl:
          "postgresql://postgres:secret@db.example.invalid:36497/other",
      },
    ],
    [
      "wrong user",
      {
        databaseUrl:
          "postgresql://other:secret@db.example.invalid:36497/railway",
      },
    ],
    [
      "wrong scheme",
      {
        databaseUrl: "https://postgres:secret@db.example.invalid:36497/railway",
      },
    ],
  ])("rejects %s", (_label, overrides) => {
    expect(() =>
      validateProductionHyperdriveAuthority({
        response,
        expectedConfigId,
        databaseUrl:
          "postgresql://postgres:secret@db.example.invalid:36497/railway",
        ...overrides,
      }),
    ).toThrow(/production_hyperdrive_binding_admission/);
  });
});
