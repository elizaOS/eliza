/**
 * Exercises canonical Cloud release ownership in pure and real-git harnesses.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  execFileSync,
  spawnSync,
} from "../../../scripts/lib/spawn-sync-captured.mjs";
import {
  decideCanonicalDeploySource,
  parseCanonicalRemoteHead,
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
    ).toMatchObject({ allowed: false, reason: "superseded_source" });
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
  });
});
