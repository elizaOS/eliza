/**
 * Locks the release workflow to the exact tested SHA and the checked-in Pages
 * output contract so local convenience commands cannot become release paths.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const workflow = readFileSync(
  join(repositoryRoot, ".github", "workflows", "eliza-computer.yml"),
  "utf8",
);
const packageManifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);
const wranglerConfiguration = readFileSync(
  join(packageRoot, "wrangler.toml"),
  "utf8",
);
const pagesHeaders = readFileSync(
  join(packageRoot, "public", "_headers"),
  "utf8",
);

describe("eliza.army deployment contract", () => {
  it("deploys only the exact tested SHA through wrangler.toml", () => {
    const deployJob = workflow.slice(workflow.indexOf("\n  deploy:"));
    expect(deployJob).toContain(`ref: ${"$"}{{ github.sha }}`);
    expect(deployJob).toContain('checked_out_sha="$(git rev-parse HEAD)"');
    expect(deployJob).toContain("bunx wrangler@4.100.0 pages deploy \\");
    expect(deployJob).not.toContain("pages deploy dist");
    expect(deployJob).toContain('--commit-hash="$GITHUB_SHA"');
    expect(deployJob).toContain("--commit-dirty=false");
    expect(deployJob).toContain("select-pages-deployment.mjs");
    expect(deployJob).toContain("new, successful, clean production deployment");
    expect(wranglerConfiguration).toContain(
      'pages_build_output_dir = "./dist"',
    );
  });

  it("keeps production deploy authority out of package scripts", () => {
    expect(packageManifest.scripts.deploy).toBeUndefined();
    expect(packageManifest.scripts["test:e2e:record:production"]).toBe(
      "node scripts/record-evidence.mjs --production",
    );
  });

  it("cache-busts every post-deploy byte comparison", () => {
    const verificationStep = workflow.slice(
      workflow.indexOf("- name: Verify published skill and leaderboard"),
    );
    expect(verificationStep).toContain('--header "Cache-Control: no-cache"');
    expect(verificationStep).toContain('--header "Pragma: no-cache"');
    expect(verificationStep).toContain(
      "?verify=$GITHUB_SHA-$GITHUB_RUN_ATTEMPT-$attempt",
    );
    expect(verificationStep).toContain("--connect-timeout 10");
    expect(verificationStep).toContain("--max-time 30");
  });

  it("serves HTTPS policy and immutable hashed assets", () => {
    expect(pagesHeaders).toContain(
      "Strict-Transport-Security: max-age=31536000; includeSubDomains",
    );
    expect(pagesHeaders).toContain("style-src 'self';");
    expect(pagesHeaders).not.toContain("'unsafe-inline'");
    expect(pagesHeaders).toContain("/assets/*");
    expect(pagesHeaders).toContain(
      "Cache-Control: public, max-age=31536000, immutable",
    );
  });
});
