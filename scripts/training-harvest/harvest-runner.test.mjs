import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseHarvestLimit } from "./harvest-runner.mjs";

const runner = fileURLToPath(new URL("./harvest-runner.mjs", import.meta.url));

test("parseHarvestLimit accepts the unlimited sentinel and safe bounds", () => {
  assert.equal(parseHarvestLimit("0"), 0);
  assert.equal(parseHarvestLimit("12"), 12);
  assert.equal(parseHarvestLimit("00012"), 12);
  assert.equal(
    parseHarvestLimit(String(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER,
  );
});

test("parseHarvestLimit rejects values that JavaScript would partially coerce", () => {
  for (const raw of [
    "",
    " ",
    " 12",
    "12 ",
    "-1",
    "+1",
    "1.5",
    "1e2",
    "12junk",
    "Infinity",
    `${String(Number.MAX_SAFE_INTEGER)}0`,
  ]) {
    assert.throws(() => parseHarvestLimit(raw), /--limit must be/);
  }
});

test("invalid --limit fails before deterministic CLI planning", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--deterministic",
      "--family",
      "unsupported",
      "--limit",
      "-1",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /--limit must be/);
  assert.doesNotMatch(
    result.stdout,
    /providerSource|requires trajectory wiring/,
  );
});
