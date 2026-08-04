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
  it("deploys only the exact tested SHA through wrangler.toml", () => {
    expect(qualityJob).toContain(`ref: ${"$"}{{ github.sha }}`);
    expect(qualityJob).toContain("does not match the event SHA $GITHUB_SHA");
    expect(deployJob).toContain(`ref: ${"$"}{{ github.sha }}`);
    expect(deployJob).toContain('checked_out_sha="$(git rev-parse HEAD)"');
    expect(deployJob).toContain(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    expect(deployJob).toContain(
      "uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    );
    expect(deployJob).toContain(`node-version: ${"$"}{{ env.NODE_VERSION }}`);
    expect(deployJob).toContain("./node_modules/.bin/wrangler pages deploy \\");
    expect(deployJob).toContain("working-directory: packages/eliza-computer");
    expect(deployJob).not.toContain("bunx wrangler");
    expect(deployJob).not.toContain("pages deploy dist");
    expect(deployJob).toContain('--commit-hash="$GITHUB_SHA"');
    expect(deployJob).toContain("--commit-dirty=false");
    expect(deployJob).toContain("select-pages-deployment.mjs");
    expect(deployJob).toContain("new, successful, clean production deployment");
    expect(
      deployJob.match(
        /git -C "\$GITHUB_WORKSPACE" ls-remote --exit-code --refs/g,
      ),
    ).toHaveLength(2);
    expect(
      deployJob.match(
        /git -C "\$GITHUB_WORKSPACE" diff --quiet "\$GITHUB_SHA" "\$live_develop"/g,
      ),
    ).toHaveLength(2);
    expect(deployJob).toContain(
      "changed an eliza.army release input immediately before deployment",
    );
    for (const releaseInput of [
      "packages/eliza-computer",
      "packages/skills/skills/contribute-to-eliza",
      "packages/skills/skills/skill-creator/scripts/package_skill.py",
      "packages/skills/skills/skill-creator/scripts/quick_validate.py",
      "packages/shared/assets/logos",
      "packages/shared/scripts/sync-to-public.mjs",
      "packages/scripts/rm-path-recursive.mjs",
      "bun.lock package.json",
    ]) {
      expect(deployJob).toContain(releaseInput);
    }
    expect(wranglerConfiguration).toContain(
      'pages_build_output_dir = "./dist"',
    );
    expect(packageManifest.devDependencies.wrangler).toBe("4.100.0");
    expect(packageManifest.scripts.build).toContain(
      "node scripts/dist-manifest.mjs create dist",
    );
  });

  it("keeps every release path restricted to develop", () => {
    expect(workflow).toContain(
      `cancel-in-progress: ${"$"}{{ github.event_name == 'pull_request' }}`,
    );
    // Trusted develop runs must never share a workflow-level concurrency
    // group: a deploy waiting on environment approval would queue-cancel
    // every newer scheduled quality run and freeze the published data.
    expect(workflow).toContain(
      `group: eliza-computer-${"$"}{{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}`,
    );
    expect(workflow).not.toContain(
      `group: eliza-computer-${"$"}{{ github.event.pull_request.number || github.ref }}`,
    );
    expect(deployJob).toContain(
      "github.event_name == 'push' && github.ref == 'refs/heads/develop'",
    );
    expect(deployJob).toContain(
      "github.event_name == 'schedule' && github.ref == 'refs/heads/develop'",
    );
    expect(deployJob).not.toContain("github.event_name == 'pull_request'");
    expect(deployJob).toContain(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/develop'",
    );
    expect(deployJob).toContain(
      'if [ "$GITHUB_REF" != "refs/heads/develop" ]; then',
    );
    expect(deployJob).toContain("group: eliza-computer-production");
    expect(deployJob).toContain("cancel-in-progress: false");
    expect(deployJob).toContain("name: eliza-army-production");
  });

  it("never regresses the published contribution snapshot", () => {
    // Independent develop runs release in approval order, not run order, so
    // the deploy must refuse to overwrite newer live data with an older
    // artifact and must read freshness from generatedAt at release time.
    const guardStep = deployJob.slice(
      deployJob.indexOf(
        "- name: Refuse to regress the published data snapshot",
      ),
      deployJob.indexOf("- name: Require live release-input equivalence"),
    );
    expect(guardStep).toContain(
      "packages/eliza-computer/dist/data/leaderboard.json",
    );
    expect(guardStep).toContain("https://eliza.army/data/leaderboard.json");
    expect(guardStep).toContain('--header "Cache-Control: no-cache"');
    expect(guardStep).toContain(
      "A superseded release must not regress published data",
    );
    expect(guardStep).toContain('if [ "$live_ms" -gt "$artifact_ms" ]; then');
    // The guard runs after the artifact download and before any Cloudflare
    // credential is referenced.
    const downloadIndex = deployJob.indexOf(
      "- name: Download verified Pages bundle",
    );
    const guardIndex = deployJob.indexOf(
      "- name: Refuse to regress the published data snapshot",
    );
    const credentialIndex = deployJob.indexOf(
      "- name: Require scoped Cloudflare credentials",
    );
    expect(downloadIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(downloadIndex);
    expect(credentialIndex).toBeGreaterThan(guardIndex);
  });

  it("has no candidate-controlled production release path", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("release_mode");
    expect(workflow).not.toContain("production-candidate");
    expect(workflow).not.toContain("candidate_pr");
    expect(workflow).not.toContain("Candidate PR");
    expect(deployJob).not.toContain("pulls/$CANDIDATE_PR");
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
    expect(verificationStep).toContain(
      "verify_download / packages/eliza-computer/dist/index.html index.html",
    );
    expect(verificationStep).not.toContain(
      "verify_download /index.html packages/eliza-computer/dist/index.html",
    );
    expect(verificationStep).toContain(
      `"https://eliza.army${"$"}{remote_path}?verify=`,
    );
    expect(verificationStep).toContain(
      "node packages/eliza-computer/scripts/dist-manifest.mjs verify",
    );
    expect(verificationStep.match(/verify_download \//g)).toHaveLength(1);
    expect(verificationStep).toContain('while [ "$attempt" -le 3 ]');
    expect(verificationStep).toContain("https://eliza.army \\");
    expect(verificationStep).toContain('"$GITHUB_SHA-$GITHUB_RUN_ATTEMPT"');
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
