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
const qualityJob = workflow.slice(
  workflow.indexOf("\n  quality:"),
  workflow.indexOf("\n  deploy:"),
);
const deployJob = workflow.slice(workflow.indexOf("\n  deploy:"));

describe("eliza.army deployment contract", () => {
  it("deploys only the admitted bundle SHA through wrangler.toml", () => {
    expect(qualityJob).toContain(`ref: ${"$"}{{ github.sha }}`);
    expect(qualityJob).toContain("does not match the event SHA $GITHUB_SHA");
    expect(deployJob).toContain('checked_out_sha="$(git rev-parse HEAD)"');
    expect(deployJob).toContain("./node_modules/.bin/wrangler pages deploy \\");
    expect(deployJob).not.toContain("pages deploy dist");
    expect(deployJob).toContain('--commit-hash="$BUNDLE_SHA"');
    expect(deployJob).toContain("--commit-dirty=false");
    expect(deployJob).toContain("select-pages-deployment.mjs");
    expect(deployJob).toContain("new, successful, clean production deployment");
    expect(wranglerConfiguration).toContain(
      'pages_build_output_dir = "./dist"',
    );
  });

  it("runs the secret-bearing lane from protected-branch code only", () => {
    // The candidate ref must never supply the workflow definition, the
    // admission check, or the deployment scripts that execute beside the
    // production Cloudflare credentials.
    expect(deployJob).toContain("ref: refs/heads/develop");
    expect(deployJob).not.toContain(`ref: ${"$"}{{ github.sha }}`);
    expect(deployJob).toContain("is not current origin/develop");
    expect(deployJob).toContain(
      "Production releases must be dispatched from develop",
    );
  });

  it("resolves release tooling from the lockfile, never from a registry", () => {
    expect(deployJob).toContain(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    expect(deployJob).toContain(
      "packages/eliza-computer/node_modules/.bin/wrangler",
    );
    expect(deployJob).toContain('EXPECTED_WRANGLER_VERSION: "4.100.0"');
    expect(deployJob).toContain("the release contract requires");
    expect(deployJob).not.toContain("bunx wrangler");
    expect(packageManifest.devDependencies.wrangler).toBe("4.100.0");
  });

  it("admits a candidate bundle by run identity, not by candidate code", () => {
    expect(deployJob).toContain("candidate_run_id");
    expect(deployJob).toContain('run.conclusion !== "success"');
    expect(deployJob).toContain("run.path !== expectedWorkflowPath");
    expect(deployJob).toContain(
      "run.head_repository?.full_name !== run.repository?.full_name",
    );
    expect(deployJob).toContain(
      "is not the current head of an open same-repository pull request into develop",
    );
    expect(deployJob).toContain(
      `run-id: ${"$"}{{ steps.admit.outputs.bundle_run_id }}`,
    );
  });

  it("keeps automatic and pull-request release authority fail closed", () => {
    expect(deployJob).toContain(
      "github.event_name == 'push' && github.ref == 'refs/heads/develop'",
    );
    expect(deployJob).toContain(
      "github.event_name == 'schedule' && github.ref == 'refs/heads/develop'",
    );
    expect(deployJob).not.toContain("github.event_name == 'pull_request'");
    expect(deployJob).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.release_mode == 'production-candidate'",
    );
    expect(deployJob).toContain("group: eliza-computer-production");
    expect(deployJob).toContain("cancel-in-progress: false");
    expect(deployJob).toContain("name: eliza-army-production");
  });

  it("admits a manual candidate bundle only from a current same-repository PR", () => {
    expect(workflow).toContain("default: quality-only");
    expect(workflow).toContain("- production-candidate");
    expect(workflow).toContain("candidate_run_id:");
    expect(workflow).not.toContain("candidate_pr:");
    expect(deployJob).toContain(
      'if ! [[ "$CANDIDATE_RUN_ID" =~ ^[1-9][0-9]*$ ]]; then',
    );
    expect(deployJob).toContain('pullRequest.state === "open"');
    expect(deployJob).toContain('pullRequest.base?.ref === "develop"');
    expect(deployJob).toContain(
      "pullRequest.head?.repo?.full_name === expectedRepository",
    );
    expect(deployJob).toContain("pullRequest.head?.sha === candidateSha");
    expect(deployJob).toContain(
      'git rev-list --count "$candidate_sha..refs/remotes/origin/develop"',
    );
    expect(deployJob).toContain('if [ "$behind_count" != "0" ]; then');
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
      "?verify=$BUNDLE_SHA-$GITHUB_RUN_ATTEMPT-$attempt",
    );
    expect(verificationStep).toContain("--connect-timeout 10");
    expect(verificationStep).toContain("--max-time 30");
    expect(verificationStep).toContain(
      "verify_download / packages/eliza-computer/dist/index.html index.html",
    );
    expect(verificationStep).not.toContain(
      "verify_download /index.html packages/eliza-computer/dist/index.html",
    );
    expect(verificationStep).toContain(
      `"https://eliza.army${"$"}{remote_path}?verify=`,
    );
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
