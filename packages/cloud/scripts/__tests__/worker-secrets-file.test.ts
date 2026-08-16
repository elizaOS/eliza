/**
 * Exercises the runner-private Worker secrets file boundary with real files,
 * including permissions, value fidelity, validation, and cleanup containment.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../../../scripts/lib/spawn-sync-captured.mjs";
import {
  buildWorkerSecrets,
  createWorkerSecretsFile,
  removeWorkerSecretsFile,
} from "../worker-secrets-file.mjs";

const temporaryDirectories: string[] = [];
const scriptPath = new URL("../worker-secrets-file.mjs", import.meta.url)
  .pathname;

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "worker-secrets-file-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Worker secrets payload", () => {
  test("preserves exact values without inheriting unnamed environment data", () => {
    const payload = buildWorkerSecrets(["DATABASE_URL", "OIDC_CLIENTS"], {
      DATABASE_URL: "postgres://example.test/a?token=sensitive",
      OIDC_CLIENTS: '{"client":"secret"}',
      UNNAMED_SECRET: "must-not-be-written",
    });

    expect(payload).toEqual({
      DATABASE_URL: "postgres://example.test/a?token=sensitive",
      OIDC_CLIENTS: '{"client":"secret"}',
    });
    expect(JSON.stringify(payload)).not.toContain("must-not-be-written");
  });

  test("rejects malformed, duplicated, and blank requested names", () => {
    expect(() => buildWorkerSecrets(["lowercase"], {})).toThrow(
      "name is invalid",
    );
    expect(() =>
      buildWorkerSecrets(["DATABASE_URL", "DATABASE_URL"], {
        DATABASE_URL: "configured",
      }),
    ).toThrow("duplicated");
    expect(() =>
      buildWorkerSecrets(["DATABASE_URL"], { DATABASE_URL: " " }),
    ).toThrow("missing or blank");
  });
});

describe("Worker secrets file lifecycle", () => {
  test("creates mode-0600 JSON and removes the exact owned file", () => {
    const runnerTemp = makeTemporaryDirectory();
    const filePath = createWorkerSecretsFile({
      runnerTemp,
      names: ["DATABASE_URL", "OIDC_CLIENTS"],
      environment: {
        DATABASE_URL: "postgres://configured",
        OIDC_CLIENTS: "[]",
      },
    });

    expect(
      filePath.startsWith(`${realpathSync(runnerTemp)}/eliza-worker-secrets-`),
    ).toBe(true);
    expect(lstatSync(filePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      DATABASE_URL: "postgres://configured",
      OIDC_CLIENTS: "[]",
    });

    removeWorkerSecretsFile({ runnerTemp, filePath });
    expect(() => lstatSync(filePath)).toThrow();
    expect(() =>
      removeWorkerSecretsFile({ runnerTemp, filePath }),
    ).not.toThrow();
  });

  test("rejects paths outside the owned naming and directory boundary", () => {
    const runnerTemp = makeTemporaryDirectory();
    const otherDirectory = makeTemporaryDirectory();
    const unrelated = join(runnerTemp, "unrelated.json");
    writeFileSync(unrelated, "{}", { mode: 0o600 });

    expect(() =>
      removeWorkerSecretsFile({ runnerTemp, filePath: unrelated }),
    ).toThrow("outside the owned runner path");
    expect(() =>
      removeWorkerSecretsFile({
        runnerTemp,
        filePath: join(
          otherDirectory,
          "eliza-worker-secrets-00000000-0000-4000-8000-000000000000.json",
        ),
      }),
    ).toThrow("outside the owned runner path");
  });

  test("does not follow a symlink with an owned-looking name", () => {
    const runnerTemp = makeTemporaryDirectory();
    const target = join(runnerTemp, "target.json");
    const link = join(
      runnerTemp,
      "eliza-worker-secrets-00000000-0000-4000-8000-000000000000.json",
    );
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, link);

    expect(() =>
      removeWorkerSecretsFile({ runnerTemp, filePath: link }),
    ).toThrow("not an owned regular file");
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  test("removes all owned files without touching unrelated runner files", () => {
    const runnerTemp = makeTemporaryDirectory();
    const first = createWorkerSecretsFile({
      runnerTemp,
      names: ["DATABASE_URL"],
      environment: { DATABASE_URL: "first" },
    });
    const second = createWorkerSecretsFile({
      runnerTemp,
      names: ["OIDC_CLIENTS"],
      environment: { OIDC_CLIENTS: "second" },
    });
    const unrelated = join(runnerTemp, "unrelated.json");
    writeFileSync(unrelated, "{}", { mode: 0o600 });

    const removed = spawnSync(
      process.execPath,
      [scriptPath, "remove-all", runnerTemp],
      { encoding: "utf8", env: process.env },
    );

    expect(removed.status, `${removed.stdout}${removed.stderr}`).toBe(0);
    expect(() => lstatSync(first)).toThrow();
    expect(() => lstatSync(second)).toThrow();
    expect(readFileSync(unrelated, "utf8")).toBe("{}");
  });

  test("executable create and remove expose only the owned path", () => {
    const runnerTemp = makeTemporaryDirectory();
    const sensitiveValue = "sensitive-value-must-not-reach-output";
    const created = spawnSync(
      process.execPath,
      [scriptPath, "create", runnerTemp, "DATABASE_URL"],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: sensitiveValue },
      },
    );

    expect(created.status, `${created.stdout}${created.stderr}`).toBe(0);
    expect(`${created.stdout}${created.stderr}`).not.toContain(sensitiveValue);
    const filePath = String(created.stdout).trim();
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      DATABASE_URL: sensitiveValue,
    });

    const removed = spawnSync(
      process.execPath,
      [scriptPath, "remove", runnerTemp, filePath],
      { encoding: "utf8", env: process.env },
    );
    expect(removed.status, `${removed.stdout}${removed.stderr}`).toBe(0);
    expect(`${removed.stdout}${removed.stderr}`).not.toContain(sensitiveValue);
    expect(() => lstatSync(filePath)).toThrow();
  });
});
