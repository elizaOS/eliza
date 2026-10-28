import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createTaskSealer,
  deriveTaskKeys,
  sealedFilePorts,
  sealedTextCodec,
  writePrivateFileSync,
} from "./task-storage-sealing.mjs";

const namespace = "example";
const master = Uint8Array.from({ length: 32 }, (_, i) => i);
const unavailable = { code: "TASK_STORAGE_UNAVAILABLE" };

test("key derivation and sealed format stay stable for existing data", () => {
  const keys = deriveTaskKeys(master, { namespace });
  assert.equal(
    keys.database.toString("hex"),
    "2c3d9dc1898f3e39f0a5e6c5f4bf10a4d849faf2d3c8699a9ac5ee08f9fc8ff7",
  );
  assert.equal(
    keys.files.toString("hex"),
    "0bb75b769d26ea00a2ad9636dba00c6a0f088440883d2879af5f706ba49749b8",
  );
  const sealer = createTaskSealer(keys.files, { namespace });
  // Written by an earlier build; it must still open.
  const stored =
    "example-sealed-v1.NKREfS1htyloNoxZNmmuCUkoMjVsYvWMIsaTJkONJ_Hao6uYbxY";
  assert.equal(sealer.open(stored, "outcome-journal"), '{"id":"a"}');
  assert.throws(() => sealer.open(stored, "task-evidence"), unavailable);
  keys.wipe();
  assert.ok(keys.database.every((byte) => byte === 0));
  assert.ok(keys.files.every((byte) => byte === 0));
});

test("sealed values are single lines bound to namespace, purpose and key", () => {
  const { files } = deriveTaskKeys(master, { namespace });
  const sealer = createTaskSealer(files, { namespace });
  const codec = sealedTextCodec(sealer, "outcome-journal");
  const line = codec.encode("line one\nline two");
  assert.match(line, /^example-sealed-v1\.[A-Za-z0-9_-]+$/);
  assert.equal(sealer.isSealed(line), true);
  assert.equal(codec.decode(line), "line one\nline two");
  const other = createTaskSealer(files, { namespace: "other" });
  assert.equal(other.isSealed(line), false);
  assert.throws(() => other.open(line, "outcome-journal"), unavailable);
  const tampered = `${line.slice(0, -2)}${line.endsWith("AA") ? "AB" : "AA"}`;
  assert.throws(() => codec.decode(tampered), unavailable);
  assert.throws(() => codec.decode(`${line}*`), unavailable);
  sealer.wipe();
  assert.throws(() => codec.encode("after wipe"), unavailable);
  for (const options of [{}, { namespace: "Bad Name" }])
    assert.throws(() => deriveTaskKeys(master, options), unavailable);
  assert.throws(
    () => deriveTaskKeys(new Uint8Array(16), { namespace }),
    unavailable,
  );
});

test("private files are replaced whole with owner-only permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "task-sealing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "diagnostics");
  const file = join(directory, "journal.json");
  writePrivateFileSync(file, "first");
  writePrivateFileSync(file, Buffer.from("second"));
  assert.equal(await readFile(file, "utf8"), "second");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(directory), ["journal.json"]);

  const { files } = deriveTaskKeys(master, { namespace });
  const ports = sealedFilePorts(
    createTaskSealer(files, { namespace }),
    "diagnostics-journal",
  );
  ports.writeFile(file, '{"entries":[]}');
  assert.match(await readFile(file, "utf8"), /^example-sealed-v1\.\S+\n$/);
  assert.equal(ports.readFile(file), '{"entries":[]}');
  ports.removeFile(file);
  assert.throws(() => ports.readFile(file), { code: "ENOENT" });
});
