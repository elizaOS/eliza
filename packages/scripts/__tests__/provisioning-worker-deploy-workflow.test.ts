import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const workflow = readFileSync(
  join(root, ".github/workflows/deploy-eliza-provisioning-worker.yml"),
  "utf8",
);
const services = [
  "packages/scripts/cloud/admin/eliza-provisioning-worker.service",
  "packages/scripts/cloud/admin/eliza-agent-router.service",
].map((path) => readFileSync(join(root, path), "utf8"));

describe("provisioning worker deployment contract", () => {
  it("resolves one immutable SHA and deploys exactly that snapshot", () => {
    expect(workflow).toContain('deployment_sha="$PUSH_SHA"');
    expect(workflow).toContain(
      'git ls-remote "https://github.com/$' + '{GITHUB_REPOSITORY}.git"',
    );
    expect(workflow).toContain(
      'fetch --no-recurse-submodules origin "$DEPLOY_SHA"',
    );
    expect(workflow).toContain('-B "$DEPLOY_BRANCH" "$DEPLOY_SHA"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"');
    expect(workflow).toContain('git checkout "$DEPLOY_SHA" -- bun.lock');
    expect(workflow).not.toContain(
      'origin "+$DEPLOY_BRANCH:refs/remotes/origin/$DEPLOY_BRANCH"',
    );
  });

  it("permits an auditable exact commit only through protected staging dispatch", () => {
    expect(workflow).toContain("deployment_sha:");
    expect(workflow).toContain('elif [ -n "$REQUESTED_SHA" ]; then');
    expect(workflow).toContain('[ "$TARGET_ENVIRONMENT" = "staging" ] || {');
    expect(workflow).toContain('[[ "$REQUESTED_SHA" =~ ^[0-9a-f]{40}$ ]] || {');
    expect(workflow).toContain(
      '"https://github.com/$' + '{GITHUB_REPOSITORY}.git" "$REQUESTED_SHA"',
    );
    expect(workflow).toContain('[ "$deployment_sha" = "$REQUESTED_SHA" ] || {');
    expect(workflow).toContain(
      "($" +
        "{{ needs.determine-env.outputs.environment }} @ $" +
        "{{ needs.determine-env.outputs.deployment_sha }})",
    );
  });

  it("fails checkout cleanup loudly and covers all shared-package changes", () => {
    expect(workflow).toContain("git reset --hard HEAD\n");
    expect(workflow).not.toContain("git reset --hard HEAD 2>/dev/null || true");
    expect(workflow).toContain("- 'packages/shared/**'");
  });

  it("regenerates before deploy and self-heals both services", () => {
    expect(workflow).toContain(
      "bash packages/scripts/cloud/admin/ensure-generated-keywords.sh",
    );
    for (const service of services) {
      expect(service).toContain(
        "ExecStartPre=/opt/eliza/packages/scripts/cloud/admin/ensure-generated-keywords.sh",
      );
    }
  });
});
