/** Runs the production filesystem service in Android's packaged Bun runtime. */
import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { DeviceFilesystemBridge } from "../../../../plugins/plugin-native-filesystem/src/services/device-filesystem-bridge";

const phase = process.argv[2];
assert(phase === "write" || phase === "reopen");
const state = process.env.ELIZA_STATE_DIR;
assert(state, "isolated state directory is required");
const service = await DeviceFilesystemBridge.start(new AgentRuntime({}));
const text = "Full Unicode café 漢字 👋\nembedded NUL:\0\n".repeat(4096);
const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
const observations: Record<string, unknown> = {
  phase,
  runtime: process.versions,
  backend: "Node on Android Bun",
};
try {
  if (phase === "write") {
    await service.write("nested/文字.txt", text);
    await service.write(
      "nested/binary.bin",
      binary.toString("base64"),
      "base64",
    );
    await service.write("overwrite.txt", "a much longer original value");
    await service.write("overwrite.txt", "short");
    await service.write("normalized\\child//file.txt", "normalized");
  }
  assert.equal(await service.read("nested/文字.txt"), text);
  assert.equal(
    await service.read("nested/binary.bin", "base64"),
    binary.toString("base64"),
  );
  assert.equal(await service.read("overwrite.txt"), "short");
  assert.equal(await service.read("normalized/child/file.txt"), "normalized");
  assert.deepEqual(
    await readFile(path.join(state, "workspace/nested/binary.bin")),
    binary,
  );
  const entries = await service.list("nested");
  assert.deepEqual(
    entries.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "binary.bin", type: "file" },
      { name: "文字.txt", type: "file" },
    ].sort((a, b) => a.name.localeCompare(b.name)),
  );
  assert(
    (await service.list("")).some(
      (entry) => entry.name === "nested" && entry.type === "directory",
    ),
  );
  observations.entries = entries;
  observations.text = await service.read("nested/文字.txt");
  observations.binaryBase64 = await service.read("nested/binary.bin", "base64");
  observations.rejectedPaths = [];
  for (const invalid of [
    "../outside.txt",
    "/absolute",
    "C:\\absolute",
    "nested/../outside.txt",
    "nul\0byte",
  ]) {
    await assert.rejects(service.read(invalid));
    await assert.rejects(service.write(invalid, "must not write"));
    await assert.rejects(service.list(invalid));
    (observations.rejectedPaths as string[]).push(invalid);
  }
  await assert.rejects(service.read("missing.txt"), { code: "ENOENT" });
  await assert.rejects(service.list("missing-directory"), { code: "ENOENT" });
  await assert.rejects(service.write("overwrite.txt/child", "invalid parent"));
  assert.equal(await service.read("overwrite.txt"), "short");
  const outside = path.join(state, "outside.txt");
  if (phase === "write") {
    await writeFile(outside, "outside sentinel");
    await symlink(outside, path.join(state, "workspace/outside-link"));
    await symlink(state, path.join(state, "workspace/outside-directory"));
  }
  await assert.rejects(service.read("outside-link"), /escapes workspace root/);
  await assert.rejects(service.write("outside-link", "must not overwrite"));
  await assert.rejects(
    service.list("outside-directory"),
    /escapes workspace root/,
  );
  await assert.rejects(
    service.write("outside-directory/outside.txt", "must not overwrite"),
  );
  assert.equal(await readFile(outside, "utf8"), "outside sentinel");
  observations.outsideSentinel = await readFile(outside, "utf8");
  observations.pass = true;
  await writeFile(
    path.join(state, `${phase}.json`),
    JSON.stringify(observations),
  );
} finally {
  await service.stop();
}
