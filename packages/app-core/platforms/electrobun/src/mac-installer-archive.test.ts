/** Exercises lossless macOS installer recompression with the installed native compressor and an independent Node decoder. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { prepareMacInstallerArchive } from "../scripts/postwrap-diagnostics";

const compressor = fileURLToPath(
  new URL(
    `../node_modules/electrobun/dist-macos-${process.arch}/zig-zstd`,
    import.meta.url,
  ),
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-installer-archive-"));
  roots.push(root);
  const bundle = path.join(root, "Eliza-canary.app");
  const resources = path.join(bundle, "Contents", "Resources");
  fs.mkdirSync(resources, { recursive: true });
  return {
    root,
    bundle,
    resources,
    update: `${bundle}.tar.zst`,
    wrapper: path.join(resources, "unchanged-hash.tar.zst"),
  };
}

it("rejects a missing installer archive before altering output", () => {
  const f = fixture();
  expect(() => prepareMacInstallerArchive(f.bundle, process.arch)).toThrow(
    "Expected one macOS installer archive",
  );
  expect(fs.readdirSync(f.resources)).toEqual([]);
});

it("rejects mismatched wrapper and update inputs without modifying either", () => {
  const f = fixture();
  fs.writeFileSync(f.update, "update");
  fs.writeFileSync(f.wrapper, "wrapper");
  expect(() => prepareMacInstallerArchive(f.bundle, process.arch)).toThrow(
    "differ before recompression",
  );
  expect(fs.readFileSync(f.update, "utf8")).toBe("update");
  expect(fs.readFileSync(f.wrapper, "utf8")).toBe("wrapper");
});

describe.skipIf(process.platform !== "darwin" || !fs.existsSync(compressor))(
  "native macOS installer compression",
  () => {
    it("preserves every payload byte and produces identical wrapper and update archives", () => {
      const f = fixture();
      const payload = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      const input = path.join(f.root, "input.tar");
      fs.writeFileSync(input, payload);
      execFileSync(compressor, [
        "compress",
        "-i",
        input,
        "-o",
        f.update,
        "-l",
        "19",
      ]);
      fs.copyFileSync(f.update, f.wrapper);
      prepareMacInstallerArchive(f.bundle, process.arch);
      const update = fs.readFileSync(f.update);
      expect(fs.readFileSync(f.wrapper).equals(update)).toBe(true);
      expect(zstdDecompressSync(update).equals(payload)).toBe(true);
      expect(fs.readdirSync(f.resources)).toEqual(["unchanged-hash.tar.zst"]);
      expect(
        fs.readdirSync(f.root).some((name) => name.includes("recompress-")),
      ).toBe(false);
    });

    it("fails corrupt input without overwriting either archive and cleans scratch output", () => {
      const f = fixture();
      fs.writeFileSync(f.update, "invalid zstd");
      fs.writeFileSync(f.wrapper, "invalid zstd");
      expect(() =>
        prepareMacInstallerArchive(f.bundle, process.arch),
      ).toThrow();
      expect(fs.readFileSync(f.update, "utf8")).toBe("invalid zstd");
      expect(fs.readFileSync(f.wrapper, "utf8")).toBe("invalid zstd");
      expect(
        fs.readdirSync(f.root).some((name) => name.includes("recompress-")),
      ).toBe(false);
    });
  },
);
