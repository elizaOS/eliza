/**
 * Exercises canonical Cloud release ownership in pure and real-git harnesses.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  execFileSync,
  spawnSync,
} from "../../../scripts/lib/spawn-sync-captured.mjs";
import {
  decideCanonicalDeploySource,
  hasEligibleSuccessorReleaseRun,
  parseCanonicalRemoteHead,
  proveSuccessorReleaseRun,
} from "../canonical-deploy-source-guard.mjs";

const RUN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../canonical-deploy-source-guard.mjs",
);

describe("canonical deploy source decision", () => {
  it("accepts only the exact canonical head", () => {
    expect(
      decideCanonicalDeploySource({
        runSha: RUN,
        canonicalRef: "refs/heads/develop",
        canonicalHead: RUN,
      }),
    ).toMatchObject({ allowed: true, reason: "current_source" });
    expect(
      decideCanonicalDeploySource({
        runSha: RUN,
        canonicalRef: "refs/heads/develop",
        canonicalHead: HEAD,
      }),
    ).toMatchObject({
      allowed: false,
      neutral: false,
      reason: "superseded_source",
    });
  });

  it("classifies a mismatch by ancestry: ancestor is neutral, divergence is fatal", () => {
    expect(
      decideCanonicalDeploySource({
        runSha: RUN,
        canonicalRef: "refs/heads/develop",
        canonicalHead: HEAD,
        runShaIsAncestorOfHead: true,
        successorRunOwnsHead: true,
      }),
    ).toMatchObject({
      allowed: false,
      neutral: true,
      reason: "superseded_source",
    });
    expect(
      decideCanonicalDeploySource({
        runSha: RUN,
        canonicalRef: "refs/heads/develop",
        canonicalHead: HEAD,
        runShaIsAncestorOfHead: true,
        successorRunOwnsHead: false,
      }),
    ).toMatchObject({
      allowed: false,
      neutral: false,
      reason: "superseded_source",
    });
    expect(
      decideCanonicalDeploySource({
        runSha: RUN,
        canonicalRef: "refs/heads/develop",
        canonicalHead: HEAD,
        runShaIsAncestorOfHead: false,
      }),
    ).toMatchObject({
      allowed: false,
      neutral: false,
      reason: "divergent_source",
    });
  });

  it("requires an exact active successor release run", () => {
    const eligible = {
      id: 200,
      head_sha: HEAD,
      head_branch: "develop",
      event: "push",
      status: "queued",
      conclusion: null,
    };
    expect(
      hasEligibleSuccessorReleaseRun(
        { workflow_runs: [eligible] },
        { canonicalHead: HEAD, currentRunId: "100" },
      ),
    ).toBe(true);
    for (const ineligible of [
      { ...eligible, id: 100 },
      { ...eligible, head_sha: RUN },
      { ...eligible, head_branch: "main" },
      { ...eligible, event: "workflow_dispatch" },
      { ...eligible, status: "completed", conclusion: "cancelled" },
      { ...eligible, status: "completed", conclusion: "failure" },
      { ...eligible, status: "completed", conclusion: "timed_out" },
      { ...eligible, status: "completed", conclusion: "skipped" },
      { ...eligible, status: "completed", conclusion: "stale" },
      { ...eligible, status: "completed", conclusion: "success" },
      { ...eligible, status: "queued", conclusion: "failure" },
      { ...eligible, status: "unknown" },
      { ...eligible, status: undefined },
    ]) {
      expect(
        hasEligibleSuccessorReleaseRun(
          { workflow_runs: [ineligible] },
          { canonicalHead: HEAD, currentRunId: "100" },
        ),
      ).toBe(false);
    }
    expect(
      hasEligibleSuccessorReleaseRun(null, {
        canonicalHead: HEAD,
        currentRunId: "100",
      }),
    ).toBe(false);
  });

  it("queries the exact Cloud CF Deploy head with an Actions-read token", async () => {
    let requestedUrl = "";
    let authorization = "";
    const proven = await proveSuccessorReleaseRun(
      HEAD,
      {
        GITHUB_REPOSITORY: "elizaOS/eliza",
        GITHUB_RUN_ID: "100",
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.test",
      },
      async (input, init) => {
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return Response.json({
          workflow_runs: [
            {
              id: 200,
              head_sha: HEAD,
              head_branch: "develop",
              event: "push",
              status: "waiting",
              conclusion: null,
            },
          ],
        });
      },
    );
    expect(proven).toBe(true);
    expect(requestedUrl).toContain(
      "/actions/workflows/cloud-cf-deploy.yml/runs",
    );
    expect(requestedUrl).toContain(`head_sha=${HEAD}`);
    expect(requestedUrl).toContain("branch=develop");
    expect(requestedUrl).toContain("event=push");
    expect(authorization).toBe("Bearer test-token");

    await expect(
      proveSuccessorReleaseRun(
        HEAD,
        {
          GITHUB_REPOSITORY: "elizaOS/eliza",
          GITHUB_RUN_ID: "100",
          GITHUB_TOKEN: "test-token",
        },
        async () => new Response("forbidden", { status: 403 }),
      ),
    ).rejects.toThrow("GitHub HTTP 403");
  });

  it("fails closed for malformed or unresolved identity", () => {
    expect(
      decideCanonicalDeploySource({
        runSha: "short",
        canonicalRef: "refs/heads/develop",
        canonicalHead: HEAD,
      }).reason,
    ).toBe("invalid_run_sha");
    expect(
      decideCanonicalDeploySource({
        runSha: RUN,
        canonicalRef: "refs/heads/feature",
        canonicalHead: HEAD,
      }).reason,
    ).toBe("invalid_canonical_ref");
    expect(
      decideCanonicalDeploySource({
        runSha: RUN,
        canonicalRef: "refs/heads/main",
        canonicalHead: null,
      }).reason,
    ).toBe("canonical_head_unresolved");
  });

  it("allows an explicit forced rollback without a resolved head", () => {
    expect(
      decideCanonicalDeploySource({
        runSha: RUN,
        canonicalRef: "refs/heads/main",
        canonicalHead: null,
        force: true,
      }),
    ).toMatchObject({ allowed: true, reason: "forced" });
  });
});

describe("canonical remote head parsing", () => {
  it("requires one exact ref and a full commit", () => {
    expect(
      parseCanonicalRemoteHead(
        `${RUN}\trefs/heads/develop\n`,
        "refs/heads/develop",
      ),
    ).toBe(RUN);
    expect(
      parseCanonicalRemoteHead(
        `${RUN}\trefs/heads/main\n`,
        "refs/heads/develop",
      ),
    ).toBeNull();
    expect(
      parseCanonicalRemoteHead(
        `${RUN}\trefs/heads/develop\n${HEAD}\trefs/heads/develop\n`,
        "refs/heads/develop",
      ),
    ).toBeNull();
    expect(
      parseCanonicalRemoteHead(
        "not-a-sha\trefs/heads/develop\n",
        "refs/heads/develop",
      ),
    ).toBeNull();
  });
});

describe("canonical deploy source CLI", () => {
  it("accepts current, rejects superseded and unresolved, and permits forced rollback", () => {
    const root = mkdtempSync(join(tmpdir(), "canonical-deploy-source-"));
    const origin = join(root, "origin");
    const clone = join(root, "clone");
    try {
      execFileSync("git", ["init", "--initial-branch=develop", origin], {
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: origin,
      });
      execFileSync("git", ["config", "user.name", "Source Guard Test"], {
        cwd: origin,
      });
      writeFileSync(join(origin, "state.txt"), "one\n");
      execFileSync("git", ["add", "state.txt"], { cwd: origin });
      execFileSync("git", ["commit", "-m", "one"], {
        cwd: origin,
        stdio: "ignore",
      });
      const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: origin })
        .toString()
        .trim();
      execFileSync("git", ["clone", origin, clone], { stdio: "ignore" });

      const current = spawnSync(
        process.execPath,
        [SCRIPT, "--run-sha", first, "--canonical-ref", "refs/heads/develop"],
        { cwd: clone, encoding: "utf8" },
      );
      expect(current.status).toBe(0);
      expect(current.stdout).toContain("current_source");

      writeFileSync(join(origin, "state.txt"), "two\n");
      execFileSync("git", ["add", "state.txt"], { cwd: origin });
      execFileSync("git", ["commit", "-m", "two"], {
        cwd: origin,
        stdio: "ignore",
      });
      const superseded = spawnSync(
        process.execPath,
        [SCRIPT, "--run-sha", first, "--canonical-ref", "refs/heads/develop"],
        { cwd: clone, encoding: "utf8" },
      );
      expect(superseded.status).toBe(1);
      expect(superseded.stdout).toContain("superseded_source");

      // Ancestry alone is insufficient: without authenticated proof of an
      // exact-head successor workflow run, neutral mode fails closed.
      const outputFile = join(root, "github-output");
      writeFileSync(outputFile, "");
      const neutral = spawnSync(
        process.execPath,
        [
          SCRIPT,
          "--run-sha",
          first,
          "--canonical-ref",
          "refs/heads/develop",
          "--neutral-when-superseded",
        ],
        {
          cwd: clone,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputFile,
            GITHUB_REPOSITORY: "",
            GITHUB_RUN_ID: "",
            GITHUB_TOKEN: "",
          },
        },
      );
      expect(neutral.status).toBe(1);
      expect(neutral.stderr).toContain(
        "GITHUB_REPOSITORY is required for successor-run proof",
      );
      expect(readFileSync(outputFile, "utf8")).toBe("");

      // Rewrite develop so the run SHA is no longer an ancestor: divergence
      // stays fatal even with the neutral flag.
      execFileSync("git", ["reset", "--hard", first], {
        cwd: origin,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "--amend", "-m", "rewritten-root"], {
        cwd: origin,
        stdio: "ignore",
      });
      const divergent = spawnSync(
        process.execPath,
        [
          SCRIPT,
          "--run-sha",
          first,
          "--canonical-ref",
          "refs/heads/develop",
          "--neutral-when-superseded",
        ],
        { cwd: clone, encoding: "utf8" },
      );
      expect(divergent.status).toBe(1);
      expect(divergent.stdout).toContain("divergent_source");

      const unresolved = spawnSync(
        process.execPath,
        [SCRIPT, "--run-sha", first, "--canonical-ref", "refs/heads/main"],
        { cwd: clone, encoding: "utf8" },
      );
      expect(unresolved.status).toBe(1);
      expect(unresolved.stderr).toContain("could not be verified");

      const forced = spawnSync(
        process.execPath,
        [
          SCRIPT,
          "--run-sha",
          first,
          "--canonical-ref",
          "refs/heads/main",
          "--force",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(forced.status).toBe(0);
      expect(forced.stdout).toContain("forced");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
