import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const workflow = readFileSync(
  join(root, ".github/workflows/deploy-eliza-provisioning-worker.yml"),
  "utf8",
);
const provisioningService = readFileSync(
  join(root, "packages/cloud/scripts/admin/eliza-provisioning-worker.service"),
  "utf8",
);
const services = [
  provisioningService,
  readFileSync(
    join(root, "packages/cloud/scripts/admin/eliza-agent-router.service"),
    "utf8",
  ),
];

describe("provisioning worker deployment contract", () => {
  it("routes both jobs only to the healthy Hetzner fleet", () => {
    expect(
      workflow.match(
        /^\s+runs-on: \$\{\{ fromJSON\(vars\.HETZNER_FLEET_ONLINE != 'true' && '\["ubuntu-24\.04"\]' \|\| '\["self-hosted","hetzner-robot"\]'\) \}\}$/gm,
      ),
    ).toHaveLength(2);
  });

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

  it("reports the resolved branch and immutable deployment SHA in both Discord receipts", () => {
    const receipt = [
      "description: |",
      "            Branch: $" + "{{ needs.determine-env.outputs.branch }}",
      "            Commit: $" +
        "{{ needs.determine-env.outputs.deployment_sha }}",
    ].join("\n");
    expect(workflow.split(receipt)).toHaveLength(3);
    expect(workflow).not.toContain("Branch: develop");
    expect(workflow).not.toContain("Commit: $" + "{{ github.sha }}");
  });

  it("fails checkout cleanup loudly and covers all shared-package changes", () => {
    expect(workflow).toContain("git reset --hard HEAD\n");
    expect(workflow).not.toContain("git reset --hard HEAD 2>/dev/null || true");
    expect(workflow).toContain("- 'packages/shared/**'");
  });

  it("regenerates before deploy and self-heals both services", () => {
    expect(workflow).toContain(
      "bash packages/cloud/scripts/admin/ensure-generated-keywords.sh",
    );
    for (const service of services) {
      expect(service).toContain(
        "ExecStartPre=/opt/eliza/packages/cloud/scripts/admin/ensure-generated-keywords.sh",
      );
    }
  });

  it("reconciles WARM_POOL_ENABLED from the protected environment so re-arms cannot drop it (#16961)", () => {
    // The daemon replenish phase self-gates on this key; if a re-arm rebuilds
    // /opt/eliza/cloud/.env.local without it, every dedicated provision
    // silently falls back to the 30-120s cold path. The flag must flow from
    // the GitHub environment VARIABLE through the SSH env passthrough into the
    // skip-empty EnvironmentFile reconcile loop.
    expect(workflow).toContain(
      "WARM_POOL_ENABLED: ${{ vars.WARM_POOL_ENABLED }}",
    );
    expect(workflow).toMatch(/envs: [^\n]*\bWARM_POOL_ENABLED\b/);
    expect(workflow).toContain('"WARM_POOL_ENABLED=$WARM_POOL_ENABLED" \\');
  });

  it("keeps the Worker warm-pool claim flag committed per wrangler environment (#16961)", () => {
    const wranglerToml = readFileSync(
      join(root, "packages/cloud/api/wrangler.toml"),
      "utf8",
    );
    // A dashboard-only var disappears on redeploy; the intended state must be
    // an explicit committed value in every environment block.
    const occurrences = wranglerToml.match(
      /^WARM_POOL_ENABLED = "(?:true|false)"$/gm,
    );
    expect(occurrences).not.toBeNull();
    expect((occurrences ?? []).length).toBe(3);
  });

  it("keeps replacement workload memory inside the control-plane service fence", () => {
    const oldSpaceMatches = [
      ...provisioningService.matchAll(
        /^Environment=NODE_OPTIONS=--max-old-space-size=(\d+)$/gm,
      ),
    ];
    const memoryHighMatches = [
      ...provisioningService.matchAll(/^MemoryHigh=(\d+)M$/gm),
    ];
    const memoryMaxMatches = [
      ...provisioningService.matchAll(/^MemoryMax=(\d+)M$/gm),
    ];

    expect(oldSpaceMatches).toHaveLength(1);
    expect(memoryHighMatches).toHaveLength(1);
    expect(memoryMaxMatches).toHaveLength(1);

    const oldSpaceMiB = Number(oldSpaceMatches[0]?.[1]);
    const memoryHighMiB = Number(memoryHighMatches[0]?.[1]);
    const memoryMaxMiB = Number(memoryMaxMatches[0]?.[1]);

    expect(oldSpaceMiB).toBe(1536);
    expect(memoryHighMiB).toBe(1792);
    expect(memoryMaxMiB).toBe(2048);
    expect(oldSpaceMiB).toBeLessThan(memoryHighMiB);
    expect(memoryHighMiB).toBeLessThan(memoryMaxMiB);
    expect(memoryHighMiB - oldSpaceMiB).toBeGreaterThanOrEqual(256);
    expect(memoryMaxMiB - oldSpaceMiB).toBeGreaterThanOrEqual(512);
  });
});
