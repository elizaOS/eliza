/**
 * Builds real package entrypoints, runs real `npm pack` exactly once per
 * allowlisted package, and verifies deterministic plans plus byte-level
 * manifest and tarball immutability in a temporary Git repository.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAndPackReleaseCandidate,
  loadReleasePlan,
  recordReleaseTransition,
  verifyReleaseCandidate,
} from "../lib/release-candidate.mjs";
import { stableStringify } from "../lib/release-contract.mjs";
import { main as candidateMain } from "../release-candidate.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function git(repoRoot: string, args: string[]) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "release-candidate-"));
  roots.push(base);
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(repoRoot);
  writeJson(path.join(repoRoot, "package.json"), {
    name: "fixture-root",
    private: true,
    workspaces: ["packages/*"],
  });
  const common = {
    version: "1.2.3",
    type: "module",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    files: ["dist"],
    publishConfig: { access: "public" },
  };
  writeJson(path.join(repoRoot, "packages/a/package.json"), {
    name: "@release-fixture/a",
    ...common,
    dependencies: { "@release-fixture/b": "1.2.3" },
  });
  writeJson(path.join(repoRoot, "packages/b/package.json"), {
    name: "@release-fixture/b",
    ...common,
  });
  fs.writeFileSync(
    path.join(repoRoot, "build.mjs"),
    [
      'import fs from "node:fs";',
      'for (const name of ["a", "b"]) {',
      '  fs.mkdirSync("packages/" + name + "/dist", { recursive: true });',
      '  fs.writeFileSync("packages/" + name + "/dist/index.js", "export const name = " + JSON.stringify(name) + ";\\n");',
      '  fs.writeFileSync("packages/" + name + "/dist/index.d.ts", "export declare const name: string;\\n");',
      "}",
      'const count = fs.existsSync("build-count") ? Number(fs.readFileSync("build-count", "utf8")) : 0;',
      'fs.writeFileSync("build-count", String(count + 1));',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "dist/\nbuild-count\n");
  git(repoRoot, ["init", "-b", "develop"]);
  git(repoRoot, ["config", "user.name", "Release Test"]);
  git(repoRoot, ["config", "user.email", "release@example.test"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "fixture"]);
  const sourceSha = git(repoRoot, ["rev-parse", "HEAD"]);
  return { base, repoRoot, sourceSha };
}

function createCandidate(
  fixture: ReturnType<typeof makeFixture>,
  name: string,
) {
  return buildAndPackReleaseCandidate({
    repoRoot: fixture.repoRoot,
    outputDirectory: path.join(fixture.base, name),
    packageNames: ["@release-fixture/a", "@release-fixture/b"],
    version: "1.2.3",
    channel: "beta",
    sourceSha: fixture.sourceSha,
    expectedCommit: fixture.sourceSha,
    build: { command: process.execPath, args: ["build.mjs"] },
    npmCommand: "npm",
  });
}

describe("immutable release candidate", () => {
  test("builds once, packs real tgz files, records entrypoints and deterministic integrity", () => {
    const fixture = makeFixture();
    const first = createCandidate(fixture, "candidate-one");
    expect(first.state.phase).toBe("candidate-recorded");
    expect(first.plan.publishOrder).toEqual([
      "@release-fixture/b",
      "@release-fixture/a",
    ]);
    expect(first.plan.dependencyGraph["@release-fixture/a"]).toEqual([
      "@release-fixture/b",
    ]);
    expect(first.plan.packages).toHaveLength(2);
    for (const packageRecord of first.plan.packages) {
      expect(packageRecord.tarball.integrity).toMatch(/^sha512-/);
      expect(packageRecord.tarball.sha512).toHaveLength(128);
      expect(packageRecord.entrypoints).toMatchObject({
        main: "dist/index.js",
        types: "dist/index.d.ts",
      });
      const bytes = fs.readFileSync(
        path.join(fixture.base, "candidate-one", packageRecord.tarball.path),
      );
      expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    }
    expect(
      fs.readFileSync(path.join(fixture.repoRoot, "build-count"), "utf8"),
    ).toBe("1");
    expect(
      verifyReleaseCandidate({
        repoRoot: fixture.repoRoot,
        candidateDirectory: path.join(fixture.base, "candidate-one"),
      }).planIntegrity,
    ).toMatch(/^sha512-/);

    expect(() => createCandidate(fixture, "candidate-one")).toThrow(
      "output already exists",
    );
    expect(
      fs.readFileSync(path.join(fixture.repoRoot, "build-count"), "utf8"),
    ).toBe("1");

    createCandidate(fixture, "candidate-two");
    expect(
      fs.readFileSync(path.join(fixture.repoRoot, "build-count"), "utf8"),
    ).toBe("2");
    expect(
      fs.readFileSync(
        path.join(fixture.base, "candidate-one/release-plan.json"),
        "utf8",
      ),
    ).toBe(
      fs.readFileSync(
        path.join(fixture.base, "candidate-two/release-plan.json"),
        "utf8",
      ),
    );
  }, 30_000);

  test("rejects candidate tarball or source mutation", () => {
    const fixture = makeFixture();
    const result = createCandidate(fixture, "candidate");
    const tarballPath = path.join(
      fixture.base,
      "candidate",
      result.plan.packages[0].tarball.path,
    );
    fs.appendFileSync(tarballPath, "tamper");
    expect(() =>
      verifyReleaseCandidate({
        repoRoot: fixture.repoRoot,
        candidateDirectory: path.join(fixture.base, "candidate"),
      }),
    ).toThrow("tarball no longer matches");

    const planPath = path.join(fixture.base, "candidate/release-plan.json");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.packages[0].tarball.path = "../outside.tgz";
    fs.writeFileSync(planPath, stableStringify(plan));
    expect(() => loadReleasePlan(path.join(fixture.base, "candidate"))).toThrow(
      "Malformed release plan",
    );
  }, 30_000);

  test("rejects concurrent state writers through an exclusive candidate lock", () => {
    const fixture = makeFixture();
    createCandidate(fixture, "candidate");
    const lockPath = path.join(
      fixture.base,
      "candidate/release-state.json.lock",
    );
    fs.writeFileSync(lockPath, "other-writer\n");
    expect(() =>
      recordReleaseTransition(
        path.join(fixture.base, "candidate"),
        "registry-bound",
        { registry: "fixture" },
      ),
    ).toThrow();
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.base, "candidate/release-state.json"),
          "utf8",
        ),
      ).phase,
    ).toBe("candidate-recorded");
  }, 30_000);

  test("recovers dead-owner and expired cross-host state locks", () => {
    const fixture = makeFixture();
    createCandidate(fixture, "candidate");
    const candidate = path.join(fixture.base, "candidate");
    const lockPath = path.join(candidate, "release-state.json.lock");
    const deadPid = Number(
      execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(String(process.pid))"],
        { encoding: "utf8" },
      ),
    );
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        ownerToken: "dead-owner",
        hostname: os.hostname(),
        pid: deadPid,
        acquiredAt: new Date().toISOString(),
      }),
    );
    expect(
      recordReleaseTransition(candidate, "registry-bound", {
        registry: "fixture",
      }).phase,
    ).toBe("registry-bound");
    expect(fs.existsSync(lockPath)).toBe(false);

    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        ownerToken: "expired-owner",
        hostname: "another-runner",
        pid: 1,
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const expired = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, expired, expired);
    expect(
      recordReleaseTransition(candidate, "registry-staged", {
        registry: "fixture",
      }).phase,
    ).toBe("registry-staged");
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 30_000);

  test("does not expire a live local state-lock owner", () => {
    const fixture = makeFixture();
    createCandidate(fixture, "candidate");
    const candidate = path.join(fixture.base, "candidate");
    const lockPath = path.join(candidate, "release-state.json.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        ownerToken: "live-owner",
        hostname: os.hostname(),
        pid: process.pid,
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const expired = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, expired, expired);
    expect(() =>
      recordReleaseTransition(candidate, "registry-bound", {
        registry: "fixture",
      }),
    ).toThrow("locked by another writer");
    expect(fs.existsSync(lockPath)).toBe(true);
  }, 30_000);

  test("CLI boundary creates, verifies, transitions, and refuses implicit public registry access", async () => {
    const fixture = makeFixture();
    const cohortPath = path.join(fixture.base, "cohort.json");
    fs.writeFileSync(
      cohortPath,
      JSON.stringify({
        schemaVersion: 1,
        packages: ["@release-fixture/a", "@release-fixture/b"],
      }),
    );
    const candidate = path.join(fixture.base, "cli-candidate");
    await candidateMain([
      "candidate",
      "--repo-root",
      fixture.repoRoot,
      "--cohort",
      cohortPath,
      "--candidate",
      candidate,
      "--version",
      "1.2.3",
      "--channel",
      "beta",
      "--source-sha",
      fixture.sourceSha,
      "--expected-commit",
      fixture.sourceSha,
      "--build-command",
      process.execPath,
      "--build-arg",
      "build.mjs",
    ]);
    await candidateMain([
      "verify",
      "--repo-root",
      fixture.repoRoot,
      "--candidate",
      candidate,
    ]);
    const evidencePath = path.join(fixture.base, "evidence.json");
    fs.writeFileSync(evidencePath, JSON.stringify({ registry: "fixture" }));
    expect(
      await candidateMain([
        "transition",
        "--candidate",
        candidate,
        "--to",
        "registry-bound",
        "--evidence",
        evidencePath,
      ]),
    ).toMatchObject({ phase: "registry-bound" });
    expect(
      await candidateMain([
        "transition",
        "--candidate",
        candidate,
        "--to",
        "registry-staged",
        "--evidence",
        evidencePath,
      ]),
    ).toMatchObject({ phase: "registry-staged" });
    await expect(
      candidateMain([
        "inspect",
        "--repo-root",
        fixture.repoRoot,
        "--candidate",
        candidate,
        "--registry",
        "https://registry.npmjs.org/",
      ]),
    ).rejects.toThrow("requires --allow-public-registry");
    expect(await candidateMain(["--help"])).toBeNull();
    await expect(candidateMain(["unknown"])).rejects.toThrow(
      "Unknown release-candidate command",
    );
  }, 30_000);
});
