/**
 * Exercises the real post-apply Pages-domain verifier CLI with representative
 * Terraform output files and value-leak canaries.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("../../../", import.meta.url);
const verifier = new URL(
  "packages/scripts/validate-terraform-pages-domain-state.mjs",
  repoRoot,
).pathname;
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixtures() {
  const proxied = { id: "secret-id-canary", proxied: true };
  return {
    canonical: {
      certificate_packs: { current: { status: "active" } },
      dns_records: { app: proxied },
      service_dns_records: { api: proxied },
    },
    domains: {
      app: { certificate_authority: "ca-canary", status: "active" },
    },
    legacyPacks: {
      redirect: { current: { status: "active" } },
      staging_agent: { status: "active" },
    },
    redirect: {
      deep_wildcards: { wildcard: proxied },
      exact: { root: proxied },
      staging_agent: { agent: proxied },
    },
    tunnel: {
      apex: {
        id: "secret-id-canary",
        proxied: false,
        roles: ["apex-routing"],
        type: "CNAME",
      },
      certificate: {
        id: "secret-id-canary",
        proxied: false,
        roles: ["wildcard-certificate"],
        type: "CNAME",
      },
      verification: {
        id: "secret-id-canary",
        proxied: false,
        roles: ["apex-verification", "wildcard-verification"],
        type: "TXT",
      },
      wildcard: {
        id: "secret-id-canary",
        proxied: false,
        roles: ["wildcard-routing"],
        type: "CNAME",
      },
    },
  };
}

function runVerifier(values, environment = "staging") {
  const directory = mkdtempSync(join(tmpdir(), "pages-domain-state-"));
  temporaryDirectories.push(directory);
  const paths = [
    ["domains.json", values.domains],
    ["canonical.json", values.canonical],
    ["tunnel.json", values.tunnel],
    ["redirect.json", values.redirect],
    ["legacy.json", values.legacyPacks],
  ].map(([name, value]) => {
    const path = join(directory, String(name));
    writeFileSync(path, JSON.stringify(value));
    return path;
  });
  return Bun.spawnSync([process.execPath, verifier, ...paths, environment], {
    stderr: "pipe",
    stdout: "pipe",
  });
}

describe("Pages-domain state verifier", () => {
  test("accepts active proxied, DNS-only, and certificate outputs", () => {
    const result = runVerifier(fixtures());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "Pages-domain state verification passed.",
    );
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects unsupported DNS types without printing protected values", () => {
    const values = fixtures();
    values.tunnel.apex.type = "A";
    const result = runVerifier(values);
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("railway_tunnel_dns.apex has unsupported type A");
    expect(stderr).not.toContain("secret-id-canary");
    expect(stderr).not.toContain("ca-canary");
  });

  test("fails closed when required tunnel roles or staging outputs are absent", () => {
    const values = fixtures();
    values.tunnel.verification.roles = [];
    values.redirect.staging_agent = {};
    values.legacyPacks.staging_agent.status = "pending_validation";
    const result = runVerifier(values);
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("apex-verification exactly once, found 0");
    expect(stderr).toContain("wildcard-verification exactly once, found 0");
    expect(stderr).toContain(
      "redirect_dns.staging_agent has no managed DNS records",
    );
    expect(stderr).toContain(
      "legacy staging agent certificate is pending_validation, expected active",
    );
  });
});
