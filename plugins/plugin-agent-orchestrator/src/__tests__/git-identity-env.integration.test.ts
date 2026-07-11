/**
 * Exercises the default coding-agent identity through a real git commit on a
 * repository with no local or global user identity.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGitIdentityEnvPatch,
  DEFAULT_GIT_IDENTITY_EMAIL,
  DEFAULT_GIT_IDENTITY_NAME,
  resolveGitIdentityConfig,
} from "../services/git-identity-env";

describe("default coding git identity", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a commit without inheriting or configuring an operator identity", () => {
    const repository = mkdtempSync(join(tmpdir(), "coding-git-identity-"));
    const home = mkdtempSync(join(tmpdir(), "coding-git-home-"));
    directories.push(repository, home);
    const env = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      ...buildGitIdentityEnvPatch(resolveGitIdentityConfig(() => undefined)),
    };

    execFileSync("git", ["init", "--quiet"], { cwd: repository, env });
    writeFileSync(join(repository, "proof.txt"), "identity proof\n", "utf8");
    execFileSync("git", ["add", "proof.txt"], { cwd: repository, env });
    execFileSync("git", ["commit", "--quiet", "-m", "identity proof"], {
      cwd: repository,
      env,
    });

    const identity = execFileSync(
      "git",
      ["show", "-s", "--format=%an|%ae|%cn|%ce", "HEAD"],
      { cwd: repository, env, encoding: "utf8" },
    ).trim();
    expect(identity).toBe(
      `${DEFAULT_GIT_IDENTITY_NAME}|${DEFAULT_GIT_IDENTITY_EMAIL}|${DEFAULT_GIT_IDENTITY_NAME}|${DEFAULT_GIT_IDENTITY_EMAIL}`,
    );
    const localIdentity = spawnSync(
      "git",
      ["config", "--local", "--get-regexp", "^user\\."],
      { cwd: repository, env, encoding: "utf8" },
    );
    expect(localIdentity.status).toBe(1);
    expect(localIdentity.stdout).toBe("");
  });
});
