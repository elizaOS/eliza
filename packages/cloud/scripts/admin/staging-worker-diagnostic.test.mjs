/**
 * Exercises journal privacy and stable source/process admission for the staging
 * diagnostic using hostile input and deterministic read-boundary responses.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  collectDiagnostic,
  summarizeImage,
  summarizeJournal,
} from "./staging-worker-diagnostic.mjs";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const PRIVATE = "private-token@example.invalid/agent-123";
const environment = `PASSWORD=${PRIVATE}\0ELIZA_AGENT_IMAGE=ghcr.io/elizaos/eliza-demo@sha256:${DIGEST}\0`;
const journal = [
  {
    MESSAGE: `[docker-sandbox] Docker health check timed out for ${PRIVATE}`,
    HOSTNAME: PRIVATE,
  },
  {
    MESSAGE: `[docker-sandbox] Container failed mesh join: headscale auth key expired/rejected ${PRIVATE}`,
  },
  { MESSAGE: PRIVATE },
]
  .map(JSON.stringify)
  .join("\n");

function hostReads({ changedSource = false, changedPid = false } = {}) {
  let sourceReads = 0;
  let pidReads = 0;
  return (file, args) => {
    if (file === "/usr/bin/git")
      return changedSource && sourceReads++ > 0 ? "c".repeat(40) : SHA;
    if (file === "/usr/bin/sudo") return journal;
    if (file === "/usr/bin/systemctl" && args.includes("--property=MainPID"))
      return changedPid && pidReads++ > 0 ? "456" : "123";
    if (
      file === "/usr/bin/systemctl" &&
      args.includes("--property=ActiveState")
    )
      return "active";
    throw new Error("unexpected command");
  };
}

test("host reads produce only public image facts and worker-level category counts", () => {
  const result = collectDiagnostic(SHA, hostReads(), (pid) => {
    assert.equal(pid, "123");
    return environment;
  });
  assert.equal(result.journal.counts.docker_health_timeout, 1);
  assert.equal(result.journal.counts.mesh_auth_rejected, 1);
  assert.equal(result.journal.records, 3);
  assert.equal(result.image.digest, `sha256:${DIGEST}`);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(JSON.stringify(result).includes("HOSTNAME"), false);
});

test("invalid expected source rejects before any host read", () => {
  let called = false;
  assert.throws(
    () =>
      collectDiagnostic("$(arbitrary-command)", () => {
        called = true;
      }),
    /expected_source_invalid/,
  );
  assert.equal(called, false);
});

test("source or process replacement during collection prevents certification", () => {
  for (const mutation of [{ changedSource: true }, { changedPid: true }]) {
    assert.throws(
      () => collectDiagnostic(SHA, hostReads(mutation), () => environment),
      /worker_changed_during_read/,
    );
  }
});

test("private or malformed image references never escape the boundary", () => {
  for (const value of [
    PRIVATE,
    `ghcr.io/elizaos/eliza-demo@sha256:${DIGEST}\n${PRIVATE}`,
  ]) {
    assert.deepEqual(summarizeImage(`ELIZA_AGENT_IMAGE=${value}\0`), {
      family: "other",
      digest: null,
    });
  }
  assert.throws(
    () => summarizeImage("PASSWORD=hidden\0"),
    /image_pin_missing_or_ambiguous/,
  );
  assert.throws(
    () => summarizeImage(environment + environment),
    /image_pin_missing_or_ambiguous/,
  );
});

test("malformed journal records cannot become healthy-looking empty observations", () => {
  assert.throws(() => summarizeJournal('{"MESSAGE":'), SyntaxError);
  assert.throws(
    () => summarizeJournal('{"MESSAGE":[1,2]}'),
    /journal_format_invalid/,
  );
  assert.equal(summarizeJournal("").records, 0);
});

test("stdin CLI rejects hostile source input without emitting it or invoking host reads", () => {
  const source = readFileSync(
    new URL("./staging-worker-diagnostic.mjs", import.meta.url),
    "utf8",
  );
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-", PRIVATE],
    { input: source, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /read failed; no private data emitted/);
  assert.equal(result.stderr.includes(PRIVATE), false);
});
