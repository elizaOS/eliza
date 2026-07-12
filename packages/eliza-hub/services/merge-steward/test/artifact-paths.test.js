import assert from "node:assert/strict";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  artifactPath,
  elizaArtifactRoot,
  elizaCacheRoot,
  elizaTmpRoot,
  prepareParent,
  tmpPath,
} from "../../../deployment/hetzner-staging/scripts/artifact-paths.mjs";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

describe("deployment artifact paths", () => {
  it("prefers explicit cache and artifact roots", () => {
    const env = {
      ELIZA_ARTIFACT_ROOT: "/state/eliza-artifacts",
      ELIZA_CACHE_ROOT: "/cache/eliza",
      ELIZA_TMP_ROOT: "/tmp/eliza-tests",
    };

    assert.equal(elizaCacheRoot(env), "/cache/eliza");
    assert.equal(elizaArtifactRoot(env), "/state/eliza-artifacts");
    assert.equal(elizaTmpRoot(env), "/tmp/eliza-tests");
    assert.equal(
      artifactPath("release.json", env),
      "/state/eliza-artifacts/release.json",
    );
    assert.equal(tmpPath("work.json", env), "/tmp/eliza-tests/work.json");
  });

  it("builds XDG paths and prepares parent directories", async () => {
    const root = await mkdtempInTestRoot("artifact-paths-");
    const env = {
      HOME: path.join(root, "home"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    };
    const output = artifactPath("nested/evidence.json", env);

    try {
      assert.equal(elizaCacheRoot(env), path.join(root, "cache", "eliza-hub"));
      assert.equal(
        elizaArtifactRoot(env),
        path.join(root, "state", "eliza-hub", "artifacts"),
      );
      assert.equal(
        elizaTmpRoot(env),
        path.join(root, "cache", "eliza-hub", "tmp"),
      );

      prepareParent(output);
      assert.equal((await stat(path.dirname(output))).isDirectory(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to home-scoped paths without XDG overrides", async () => {
    const root = await mkdtempInTestRoot("artifact-home-");
    const home = path.join(root, "home");

    try {
      await mkdir(home, { recursive: true });
      assert.equal(
        elizaCacheRoot({ HOME: home }),
        path.join(home, ".cache", "eliza-hub"),
      );
      assert.equal(
        elizaArtifactRoot({ HOME: home }),
        path.join(home, ".local", "state", "eliza-hub", "artifacts"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
