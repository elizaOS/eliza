/**
 * Exercises the deterministic release schema, explicit cohort validation, hard
 * dependency ordering, reserved identities, and monotonic retry transitions
 * entirely in-process against real temporary package manifests.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advanceReleaseState,
  createReleaseState,
  loadReleaseCohort,
  releaseTransitionEvidence,
  resolveReleaseCohort,
  stableStringify,
  validateReleaseIdentity,
} from "../lib/release-contract.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-contract-"));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  );
  return root;
}

function writePackage(
  root: string,
  dir: string,
  manifest: Record<string, unknown>,
) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(
    path.join(root, dir, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
}

function publicPackage(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    version: "1.2.3-beta.4",
    type: "module",
    publishConfig: { access: "public" },
    main: "dist/index.js",
    ...extra,
  };
}

describe("release contract", () => {
  test("stable serialization recursively orders keys", () => {
    expect(stableStringify({ z: { b: 1, a: 2 }, a: 3 })).toBe(
      '{\n  "a": 3,\n  "z": {\n    "a": 2,\n    "b": 1\n  }\n}\n',
    );
  });

  test("requires exact identities and permanently reserves beta.8-.10", () => {
    const sha = "a".repeat(40);
    expect(
      validateReleaseIdentity({
        version: "1.2.3-beta.4",
        channel: "beta",
        sourceSha: sha,
        expectedCommit: sha,
      }),
    ).toMatchObject({ version: "1.2.3-beta.4", channel: "beta" });
    expect(() =>
      validateReleaseIdentity({
        version: "^1.2.3",
        channel: "beta",
        sourceSha: sha,
        expectedCommit: sha,
      }),
    ).toThrow("exact canonical semver");
    for (const version of ["2.0.3-beta.8", "2.0.3-beta.9", "2.0.3-beta.10"]) {
      expect(() =>
        validateReleaseIdentity({
          version,
          channel: "beta",
          sourceSha: sha,
          expectedCommit: sha,
        }),
      ).toThrow("reserved failed-release residue");
    }
    expect(() =>
      validateReleaseIdentity({
        version: "1.2.3",
        channel: "latest",
        sourceSha: sha,
        expectedCommit: "b".repeat(40),
      }),
    ).toThrow("rebase and create a new candidate");
  });

  test("loads a unique explicit allowlist and rejects malformed input", () => {
    const root = makeRepo();
    const cohortPath = path.join(root, "cohort.json");
    fs.writeFileSync(
      cohortPath,
      JSON.stringify({ schemaVersion: 1, packages: ["@x/b", "@x/a"] }),
    );
    expect(loadReleaseCohort(cohortPath)).toEqual(["@x/a", "@x/b"]);
    fs.writeFileSync(cohortPath, "{nope");
    expect(() => loadReleaseCohort(cohortPath)).toThrow(
      "Invalid release cohort JSON",
    );
  });

  test("orders hard dependencies first while peer edges remain metadata, not a fake hard cycle", () => {
    const root = makeRepo();
    writePackage(
      root,
      "packages/a",
      publicPackage("@x/a", {
        dependencies: { "@x/b": "1.2.3-beta.4" },
        peerDependencies: { "@x/c": ">=1.2.3-beta.4" },
      }),
    );
    writePackage(
      root,
      "packages/b",
      publicPackage("@x/b", { peerDependencies: { "@x/a": "1.2.3-beta.4" } }),
    );
    writePackage(root, "packages/c", publicPackage("@x/c"));

    const cohort = resolveReleaseCohort({
      repoRoot: root,
      packageNames: ["@x/a", "@x/b", "@x/c"],
      version: "1.2.3-beta.4",
    });
    expect(cohort.publishOrder.indexOf("@x/b")).toBeLessThan(
      cohort.publishOrder.indexOf("@x/a"),
    );
    expect(cohort.dependencyGraph["@x/a"]).toEqual(["@x/b"]);
    expect(cohort.dependencyCycles).toEqual([]);
    expect(
      cohort.packages.find(({ name }) => name === "@x/a")?.internalDependencies,
    ).toContainEqual({
      name: "@x/c",
      section: "peerDependencies",
      range: ">=1.2.3-beta.4",
      targetVersion: "1.2.3-beta.4",
      inCohort: true,
    });
  });

  test("fails closed on missing, private, workspace, mismatched, and wrong-version packages", () => {
    const root = makeRepo();
    writePackage(
      root,
      "packages/a",
      publicPackage("@x/a", { dependencies: { "@x/b": "workspace:*" } }),
    );
    writePackage(root, "packages/b", {
      ...publicPackage("@x/b"),
      private: true,
    });

    expect(() =>
      resolveReleaseCohort({
        repoRoot: root,
        packageNames: ["@x/a"],
        version: "1.2.3-beta.4",
      }),
    ).toThrow("must be a published semver range");
    expect(() =>
      resolveReleaseCohort({
        repoRoot: root,
        packageNames: ["@x/b"],
        version: "1.2.3-beta.4",
      }),
    ).toThrow("is private");
    expect(() =>
      resolveReleaseCohort({
        repoRoot: root,
        packageNames: ["@x/missing"],
        version: "1.2.3-beta.4",
      }),
    ).toThrow("is not a workspace package");

    const aPath = path.join(root, "packages/a/package.json");
    fs.writeFileSync(
      aPath,
      JSON.stringify(
        publicPackage("@x/a", { dependencies: { "@x/b": "^2.0.0" } }),
      ),
    );
    expect(() =>
      resolveReleaseCohort({
        repoRoot: root,
        packageNames: ["@x/a"],
        version: "1.2.3-beta.4",
      }),
    ).toThrow("does not accept workspace version");
    fs.writeFileSync(
      aPath,
      JSON.stringify({ ...publicPackage("@x/a"), version: "1.2.3" }),
    );
    expect(() =>
      resolveReleaseCohort({
        repoRoot: root,
        packageNames: ["@x/a"],
        version: "1.2.3-beta.4",
      }),
    ).toThrow("expected 1.2.3-beta.4");
  });

  test("requires runtime workspace dependency closure in the explicit cohort", () => {
    const root = makeRepo();
    writePackage(
      root,
      "packages/a",
      publicPackage("@x/a", { dependencies: { "@x/b": "1.2.3-beta.4" } }),
    );
    writePackage(root, "packages/b", publicPackage("@x/b"));
    expect(() =>
      resolveReleaseCohort({
        repoRoot: root,
        packageNames: ["@x/a"],
        version: "1.2.3-beta.4",
      }),
    ).toThrow("missing from the explicit release cohort");
  });

  test("advances one phase, treats identical retry as a no-op, and rejects conflict or skips", () => {
    const initial = createReleaseState("sha512-value", { sourceSha: "abc" });
    const packed = advanceReleaseState(initial, "built-packed", {
      tarballs: ["a"],
    });
    expect(packed.phase).toBe("built-packed");
    expect(
      advanceReleaseState(packed, "built-packed", { tarballs: ["a"] }),
    ).toBe(packed);
    expect(() =>
      advanceReleaseState(packed, "built-packed", { tarballs: ["different"] }),
    ).toThrow("Conflicting evidence");
    expect(() => advanceReleaseState(packed, "registry-staged", {})).toThrow(
      "Invalid release transition",
    );
    expect(() => advanceReleaseState(packed, "planned", {})).toThrow(
      "Invalid release transition",
    );

    let complete = packed;
    for (const phase of [
      "candidate-recorded",
      "registry-bound",
      "registry-staged",
      "registry-verified",
      "channel-promoted",
      "git-bound",
      "git-tagged",
      "release-published",
      "version-sync-pr",
    ]) {
      complete = advanceReleaseState(complete, phase, { proof: phase });
    }
    expect(complete.phase).toBe("version-sync-pr");
    expect(releaseTransitionEvidence(complete, "registry-staged")).toEqual({
      proof: "registry-staged",
    });

    const malformed = structuredClone(complete);
    malformed.transitions[2].phase = "registry-staged";
    expect(() =>
      advanceReleaseState(malformed, "version-sync-pr", {
        proof: "version-sync-pr",
      }),
    ).toThrow("invalid transition history");
  });
});
