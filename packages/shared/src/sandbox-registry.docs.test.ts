/**
 * Source/docs drift guard for the SandboxRegistry route trio. Reads the
 * current-contract surfaces named by #28734 and fails if comments, the
 * staging authority, or startup diagnostics still describe a non-atomic
 * two-write pipeline, incompatible 30-day/two-minute TTLs, or heartbeat
 * recovery after SANDBOX_REGISTRY_OWNERSHIP_LOST.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function collapsed(source: string): string {
  return source.replace(/\s+/g, " ");
}

const SURFACES = {
  stagingAuthority: "packages/cloud/infra/STAGING_AUTHORITY.md",
  registry: "packages/shared/src/sandbox-registry.ts",
  webhookRouter: "packages/cloud/services/gateway-webhook/src/server-router.ts",
  agentRuntime: "packages/agent/src/runtime/eliza.ts",
  serverOnlyHost: "packages/app-core/src/runtime/startup/server-only-host.ts",
} as const;

const STALE_CLAIMS = [
  "writes two Redis keys",
  "pipelines both writes",
  "pipeline is not a Redis transaction",
  "TTL for both Redis keys",
  "only writes twice per heartbeat",
  "lives 30 days",
  "expires after two minutes",
  "heartbeat can recover after an initial",
  "until the next heartbeat succeeds",
  "until the next hb_signal succeeds",
  "privacy-safe paired-key",
] as const;

describe("SandboxRegistry trio docs and diagnostics", () => {
  const files = Object.fromEntries(
    Object.entries(SURFACES).map(([name, path]) => [
      name,
      collapsed(readRepoFile(path)),
    ]),
  ) as Record<keyof typeof SURFACES, string>;

  it("does not describe a non-atomic two-write pipeline, incompatible TTLs, or heartbeat recovery", () => {
    for (const [name, source] of Object.entries(files)) {
      for (const claim of STALE_CLAIMS) {
        expect(source, `${name} still claims: ${claim}`).not.toContain(claim);
      }
    }
  });

  it("distinguishes the public resolver pair from the private generation-fenced trio", () => {
    expect(files.registry).toContain("server:<serverName>:registration");
    expect(files.registry).toContain("SANDBOX_REGISTRY_OWNERSHIP_LOST");
    expect(files.registry).toContain("#24767");
    expect(files.registry).toContain("writer-specific");

    expect(files.stagingAuthority).toContain("EVAL");
    expect(files.stagingAuthority).toContain("90-second");
    expect(files.stagingAuthority).toContain("30-second");
    expect(files.stagingAuthority).toContain("writer-specific");
    expect(files.stagingAuthority).toContain("SANDBOX_REGISTRY_OWNERSHIP_LOST");
    expect(files.stagingAuthority).toContain("#24767");
    expect(files.stagingAuthority).toContain("publicPairFound");
    expect(files.stagingAuthority).toContain("generationKeyPresent");
    expect(files.stagingAuthority).toContain(
      "without publishing its expanded name or value",
    );

    expect(files.webhookRouter).toContain("two-key resolver view");
    expect(files.webhookRouter).toContain("server:<name>:registration");
    expect(files.webhookRouter).toContain("writer-specific");
    expect(files.webhookRouter).toContain("90-second trio TTL");

    expect(files.agentRuntime).toContain("server:<name>:registration");
    expect(files.serverOnlyHost).toContain("#24767");
  });

  it("startup diagnostics no longer promise heartbeat recreation after register failure", () => {
    const diagnostic =
      "heartbeat cannot recreate a missing trio and fails closed with SANDBOX_REGISTRY_OWNERSHIP_LOST";
    expect(files.agentRuntime).toContain(diagnostic);
    expect(files.serverOnlyHost).toContain(diagnostic);
    expect(files.agentRuntime).not.toMatch(
      /until the next (heartbeat|hb_signal) succeeds/,
    );
    expect(files.serverOnlyHost).not.toMatch(
      /until the next (heartbeat|hb_signal) succeeds/,
    );
  });
});
