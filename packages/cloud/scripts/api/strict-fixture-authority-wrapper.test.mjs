import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ownedPostgresFixtureAuthority } from "./strict-fixture-authority.mjs";

// Exercise the real wrapper without adding production test injection. Its only
// child is a test-owned fake docker executable; no daemon, DB or network exists.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "groupd-authority-wrapper-")));
  const receiptPath = join(root, "authority.json");
  const calls = join(root, "calls.txt");
  const docker = join(root, "docker");
  writeFileSync(
    docker,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.TEST_DOCKER_CALLS,'call\\n');process.stdout.write(process.argv[2]==='context'?JSON.stringify(process.env.TEST_DOCKER_ENDPOINT):process.env.TEST_DOCKER_STATE);\n`,
    { mode: 0o700 },
  );
  const receipt = {
    version: 1,
    kind: "job-owned-postgres",
    containerName: "eliza-cloud-test-postgres",
    containerId: "a".repeat(64),
    databaseUrl: "postgresql://postgres@127.0.0.1:5432/postgres",
    runId: "123",
    job: "e2e-tests",
    attempt: "1",
    createdAt: Date.now(),
  };
  const state = {
    Id: receipt.containerId,
    Name: "/eliza-cloud-test-postgres",
    State: { Running: true },
    Config: {
      Image: "pgvector/pgvector:pg16",
      Labels: {
        "eliza.e2e.run": "123",
        "eliza.e2e.job": "e2e-tests",
        "eliza.e2e.attempt": "1",
      },
    },
    NetworkSettings: {
      Ports: { "5432/tcp": [{ HostPort: "5432", HostIp: "127.0.0.1" }] },
    },
  };
  const env = {
    RUNNER_TEMP: root,
    CLOUD_E2E_DATABASE_AUTHORITY: receiptPath,
    GITHUB_RUN_ID: "123",
    GITHUB_JOB: "e2e-tests",
    GITHUB_RUN_ATTEMPT: "1",
    DATABASE_URL: receipt.databaseUrl,
  };
  const old = {
    PATH: process.env.PATH,
    TEST_DOCKER_STATE: process.env.TEST_DOCKER_STATE,
    TEST_DOCKER_ENDPOINT: process.env.TEST_DOCKER_ENDPOINT,
    TEST_DOCKER_CALLS: process.env.TEST_DOCKER_CALLS,
  };
  process.env.PATH = root;
  process.env.TEST_DOCKER_ENDPOINT = "unix:///var/run/docker.sock";
  process.env.TEST_DOCKER_CALLS = calls;
  function prepare() {
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    chmodSync(receiptPath, 0o600);
    process.env.TEST_DOCKER_STATE = JSON.stringify(state);
  }
  prepare();
  return {
    root,
    receiptPath,
    receipt,
    state,
    env,
    prepare,
    calls() {
      try {
        return readFileSync(calls, "utf8").trim().split("\n").length;
      } catch {
        return 0;
      }
    },
    close() {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("real wrapper validates receipt and exact fake Docker instance", () => {
  const f = fixture();
  try {
    assert.deepEqual(ownedPostgresFixtureAuthority(f.env), f.receipt);
    assert.equal(f.calls(), 2);
  } finally {
    f.close();
  }
});

for (const mode of ["id", "stopped", "image", "port", "labels"]) {
  test(`real wrapper rejects changed Docker ${mode}`, () => {
    const f = fixture();
    try {
      if (mode === "id") f.state.Id = "b".repeat(64);
      if (mode === "stopped") f.state.State.Running = false;
      if (mode === "image") f.state.Config.Image = "other-image";
      if (mode === "labels")
        f.state.Config.Labels["eliza.e2e.job"] = "other-job";
      if (mode === "port")
        f.state.NetworkSettings.Ports["5432/tcp"] = [{ HostPort: "15432" }];
      f.prepare();
      assert.throws(
        () => ownedPostgresFixtureAuthority(f.env),
        /container changed/,
      );
      assert.equal(f.calls(), 2);
    } finally {
      f.close();
    }
  });
}

for (const mode of ["dsn", "tampered-job", "unsafe-mode", "missing-file"]) {
  test(`real wrapper rejects ${mode} before Docker`, () => {
    const f = fixture();
    try {
      if (mode === "dsn")
        f.env.DATABASE_URL = "postgresql://prod.invalid/postgres";
      if (mode === "tampered-job") {
        f.receipt.job = "other-job";
        f.prepare();
      }
      if (mode === "unsafe-mode") chmodSync(f.receiptPath, 0o644);
      if (mode === "missing-file") rmSync(f.receiptPath);
      assert.throws(() => ownedPostgresFixtureAuthority(f.env));
      assert.equal(f.calls(), 0);
    } finally {
      f.close();
    }
  });
}

test("no receipt means no owned PostgreSQL authority, not a generic CI bypass", () => {
  assert.equal(ownedPostgresFixtureAuthority({ CI: "true" }), null);
});

test("remote Docker context cannot claim a local database", () => {
  const f = fixture();
  try {
    process.env.TEST_DOCKER_ENDPOINT = "tcp://remote.invalid:2376";
    assert.throws(
      () => ownedPostgresFixtureAuthority(f.env),
      /Remote Docker context/,
    );
    assert.equal(f.calls(), 1);
  } finally {
    f.close();
  }
});

test("external Worker cannot borrow a local container receipt", async () => {
  const { readFileSync } = await import("node:fs");
  const runner = readFileSync(
    new URL("../../api/test/e2e/run-e2e-batches.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    runner,
    /strictGroupD\s*&&\s*ownsLocalServer\s*&&\s*!disposableDatabase/,
  );
});
