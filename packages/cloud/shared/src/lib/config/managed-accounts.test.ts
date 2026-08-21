/**
 * Deterministic unit coverage for the managed-account manifest and verifier:
 * manifest invariants (unique ids, real secret reference names, deferred
 * entries carry owner and reason), registry-derivation consistency with the
 * OAuth provider registry, and evaluator behavior across configured, partial,
 * missing, placeholder, alternative-set, and deferred paths. Also proves the
 * manifest matches code by asserting every enforced env var has a real
 * consumer in the repository (via git grep). No credentials or network used.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { OAUTH_PROVIDERS } from "../services/oauth/provider-registry";
import {
  evaluateManagedAccount,
  MANAGED_ACCOUNTS,
  type ManagedAccountSpec,
  verifyManagedAccounts,
} from "./managed-accounts";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const REPOSITORY_ROOT = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  encoding: "utf8",
}).stdout.trim();

describe("managed-account manifest invariants", () => {
  it("has unique ids and non-empty names", () => {
    const ids = MANAGED_ACCOUNTS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of MANAGED_ACCOUNTS) {
      expect(spec.name.trim().length).toBeGreaterThan(0);
      expect(spec.console.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses valid env var names and no empty credential sets", () => {
    for (const spec of MANAGED_ACCOUNTS) {
      for (const set of spec.credentialSets) {
        expect(set.length).toBeGreaterThan(0);
        for (const name of set) {
          expect(name).toMatch(ENV_NAME_PATTERN);
        }
      }
    }
  });

  it("requires credential sets on every non-deferred entry", () => {
    for (const spec of MANAGED_ACCOUNTS) {
      if (spec.requirement.kind !== "deferred") {
        expect(spec.credentialSets.length).toBeGreaterThan(0);
      }
    }
  });

  it("deferred entries carry an owner and a reason", () => {
    const deferred = MANAGED_ACCOUNTS.filter((spec) => spec.requirement.kind === "deferred");
    expect(deferred.length).toBeGreaterThan(0);
    for (const spec of deferred) {
      if (spec.requirement.kind !== "deferred") continue;
      expect(spec.requirement.owner.trim().length).toBeGreaterThan(0);
      expect(spec.requirement.reason.trim().length).toBeGreaterThan(10);
    }
  });

  it("excludes secret patterns whose registry credential field is optional", () => {
    for (const spec of MANAGED_ACCOUNTS) {
      const provider = OAUTH_PROVIDERS[spec.id];
      if (!provider?.credentialFields || !provider.secretPatterns) continue;
      const patterns = provider.secretPatterns as Record<string, string | undefined>;
      const optionalNames = provider.credentialFields
        .filter((field) => !field.required)
        .map((field) => patterns[field.key])
        .filter((name): name is string => Boolean(name));
      for (const set of spec.credentialSets) {
        for (const optionalName of optionalNames) {
          expect(set).not.toContain(optionalName);
        }
      }
    }
  });

  it("OAuth-registry-backed entries stay in sync with the registry env vars", () => {
    for (const spec of MANAGED_ACCOUNTS) {
      const provider = OAUTH_PROVIDERS[spec.id];
      if (!provider) continue;
      const registryVars = new Set([
        ...provider.envVars,
        ...(provider.envVarAlternatives?.flat() ?? []),
        ...Object.values(provider.secretPatterns ?? {}),
      ]);
      for (const set of spec.credentialSets) {
        for (const name of set) {
          expect(registryVars.has(name)).toBe(true);
        }
      }
    }
  });

  it("every enforced secret reference name has a real consumer in the repository", () => {
    const enforcedVars = new Set(
      MANAGED_ACCOUNTS.filter((spec) => spec.requirement.kind !== "deferred").flatMap((spec) =>
        spec.credentialSets.flat(),
      ),
    );
    // POSIX ERE (git grep -E) has no \b; substring matches are fine because the
    // names are long and distinctive, and -o reports the matched name itself.
    const pattern = `(${[...enforcedVars].join("|")})`;
    const result = spawnSync(
      "git",
      [
        "grep",
        "-h",
        "-o",
        "-E",
        pattern,
        "--",
        "packages/cloud",
        "plugins",
        ":(exclude)packages/cloud/shared/src/lib/config/managed-accounts.ts",
      ],
      { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    expect(result.status).toBe(0);
    const referenced = new Set(result.stdout.split("\n").filter(Boolean));
    const unreferenced = [...enforcedVars].filter((name) => !referenced.has(name));
    expect(unreferenced).toEqual([]);
  }, 60000);
});

const CONFIGURED = "configured-contract-value";

const sample: ManagedAccountSpec = {
  id: "sample",
  name: "Sample",
  category: "foundation",
  console: "https://example.invalid",
  credentialSets: [["SAMPLE_CLIENT_ID", "SAMPLE_CLIENT_SECRET"], ["SAMPLE_API_KEY"]],
  requirement: { kind: "required" },
};

describe("evaluateManagedAccount", () => {
  it("reports configured when any one credential set is complete", () => {
    const report = evaluateManagedAccount(sample, { SAMPLE_API_KEY: CONFIGURED });
    expect(report.state).toBe("configured");
    expect(report.missingEnvVars).toEqual([]);
  });

  it("reports partial with the smallest actionable missing set", () => {
    const report = evaluateManagedAccount(sample, { SAMPLE_CLIENT_ID: CONFIGURED });
    expect(report.state).toBe("partial");
    expect(report.missingEnvVars).toEqual(["SAMPLE_CLIENT_SECRET"]);
  });

  it("reports missing when nothing is present", () => {
    const report = evaluateManagedAccount(
      { ...sample, credentialSets: [["SAMPLE_CLIENT_ID", "SAMPLE_CLIENT_SECRET"]] },
      {},
    );
    expect(report.state).toBe("missing");
    expect(report.missingEnvVars).toEqual(["SAMPLE_CLIENT_ID", "SAMPLE_CLIENT_SECRET"]);
  });

  it("treats placeholder values as absent", () => {
    const report = evaluateManagedAccount(sample, {
      SAMPLE_API_KEY: "your_sample_api_key_placeholder",
    });
    expect(report.state).toBe("missing");
  });

  it("reports deferred without failing when credentials are absent", () => {
    const report = evaluateManagedAccount(
      {
        ...sample,
        requirement: { kind: "deferred", owner: "cloud-integrations", reason: "not shipped yet" },
      },
      {},
    );
    expect(report.state).toBe("deferred");
  });

  it("reports configured for a deferred entry whose credentials exist", () => {
    const report = evaluateManagedAccount(
      {
        ...sample,
        requirement: { kind: "deferred", owner: "cloud-integrations", reason: "not shipped yet" },
      },
      { SAMPLE_API_KEY: CONFIGURED },
    );
    expect(report.state).toBe("configured");
  });

  it("marks entries with no credential sets deferred", () => {
    const report = evaluateManagedAccount({ ...sample, credentialSets: [] }, {});
    expect(report.state).toBe("deferred");
  });
});

describe("verifyManagedAccounts", () => {
  it("collects only unconfigured required accounts into requiredMissing", () => {
    const optional: ManagedAccountSpec = {
      ...sample,
      id: "sample-optional",
      requirement: { kind: "optional" },
    };
    const { reports, requiredMissing } = verifyManagedAccounts({}, [sample, optional]);
    expect(reports).toHaveLength(2);
    expect(requiredMissing.map((r) => r.id)).toEqual(["sample"]);
  });

  it("fails closed on the real manifest only through required accounts", () => {
    const { requiredMissing } = verifyManagedAccounts({});
    const requiredIds = MANAGED_ACCOUNTS.filter((s) => s.requirement.kind === "required").map(
      (s) => s.id,
    );
    expect(requiredMissing.map((r) => r.id).sort()).toEqual([...requiredIds].sort());
  });

  it("clears requiredMissing when required credentials are fully provisioned", () => {
    const env: Record<string, string> = {};
    for (const spec of MANAGED_ACCOUNTS) {
      if (spec.requirement.kind !== "required") continue;
      for (const name of spec.credentialSets[0]) {
        env[name] = CONFIGURED;
      }
    }
    const { requiredMissing } = verifyManagedAccounts(env);
    expect(requiredMissing).toEqual([]);
  });

  it("never places credential values in a report", () => {
    const { reports } = verifyManagedAccounts({ TELEGRAM_BOT_TOKEN: "secret-token-value" });
    expect(JSON.stringify(reports)).not.toContain("secret-token-value");
  });
});
