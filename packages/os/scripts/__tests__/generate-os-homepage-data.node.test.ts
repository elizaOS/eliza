import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const script = path.join(
  repositoryRoot,
  "scripts/generate-os-homepage-data.ts",
);

test("homepage data contains only candidate end-user downloads", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "elizaos-homepage-data-"),
  );
  try {
    const manifest = path.join(directory, "manifest.json");
    const output = path.join(directory, "downloads.json");
    await writeFile(
      manifest,
      JSON.stringify({
        release: {
          channel: "beta",
          availableDate: "2026-08-17",
        },
        artifacts: [
          {
            id: "image",
            kind: "raw-image",
            target: { platform: "linux", architecture: "x86_64" },
            downloadUrl: "https://example.test/image.raw.zst",
          },
          {
            id: "signature",
            kind: "signature",
            target: { platform: "linux", architecture: "x86_64" },
            downloadUrl: "https://example.test/image.raw.zst.sig",
          },
          {
            id: "usb",
            kind: "usb-installer",
            target: { platform: "linux", architecture: "x64" },
            downloadUrl: "https://example.test/usb.tar.gz",
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        script,
        "--manifest",
        manifest,
        "--output",
        output,
        "--checksums-url",
        "https://example.test/SHA256SUMS",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const generated = JSON.parse(await readFile(output, "utf8"));
    assert.equal(generated.product, "elizaOS");
    assert.deepEqual(
      generated.artifacts.map((artifact) => artifact.id),
      ["image", "usb"],
    );
    assert.ok(
      generated.artifacts.every(
        (artifact) =>
          artifact.checksumUrl === "https://example.test/SHA256SUMS",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
