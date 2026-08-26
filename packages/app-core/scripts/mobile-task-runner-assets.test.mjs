/**
 * Verifies real byte staging and drift rejection for the canonical mobile task
 * runner without treating either checked-in platform copy as an oracle.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  checkMobileTaskRunnerAssets,
  MOBILE_TASK_RUNNER_SOURCE,
  syncMobileTaskRunnerAssets,
} from "./mobile-task-runner-assets.mjs";

const roots = [];

after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("stages identical app-public, Android, and iOS runner bytes and rejects drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eliza-mobile-runner-"));
  roots.push(root);
  const targets = [
    path.join(root, "app-public.js"),
    path.join(root, "android.js"),
    path.join(root, "ios.js"),
  ];

  await syncMobileTaskRunnerAssets({ targets });
  const canonical = await readFile(MOBILE_TASK_RUNNER_SOURCE);
  for (const target of targets) {
    assert.deepEqual(await readFile(target), canonical);
  }
  await checkMobileTaskRunnerAssets({ targets });

  await writeFile(targets[1], "drift");
  await assert.rejects(
    checkMobileTaskRunnerAssets({ targets }),
    /mobile task runner assets are stale/u,
  );
});
