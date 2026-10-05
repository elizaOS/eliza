import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../linux/mkosi-macos-lima.sh", import.meta.url),
);
test("Lima start refuses an unreadable VM inventory without starting a VM", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mkosi-lima-"));
  try {
    const log = path.join(directory, "commands");
    await writeFile(
      path.join(directory, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n',
      { mode: 0o700 },
    );
    await writeFile(
      path.join(directory, "limactl"),
      '#!/bin/sh\nprintf "%s\\n" "$1" >> "$LIMA_LOG"\necho "inventory unavailable" >&2\nexit 17\n',
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      LIMA_LOG: log,
      ELIZAOS_LIMA_GUEST_OUT: "/var/tmp/image",
      ELIZAOS_LIMA_GUEST_EVIDENCE: "/var/tmp/evidence",
      ELIZAOS_LIMA_INSTANCE: "test",
      ELIZAOS_LIMA_VM_TYPE: "vz",
    };
    const result = spawnSync("bash", [script, "start"], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 17, result.stderr);
    assert.match(result.stderr, /inventory unavailable/);
    assert.equal(await readFile(log, "utf8"), "list\n");
    for (const key of [
      "ELIZAOS_LIMA_GUEST_OUT",
      "ELIZAOS_LIMA_GUEST_EVIDENCE",
    ]) {
      for (const value of [
        "/var/tmp/../outside",
        "/var/tmp/./image",
        "/var/tmp//image",
        "/var/tmp",
        "/other/image",
      ]) {
        const invalid = spawnSync("bash", [script, "start"], {
          env: { ...env, [key]: value },
          encoding: "utf8",
        });
        assert.equal(invalid.status, 64, `${key}=${value}: ${invalid.stderr}`);
      }
    }
    assert.equal(await readFile(log, "utf8"), "list\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
