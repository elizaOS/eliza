/** Exercises browser-target bundling and execution through the public package entrypoints. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("browser consumers retain working llama and OCR exports without host modules", async () => {
  const outdir = await mkdtemp(join(tmpdir(), "native-inference-browser-"));
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        join(import.meta.dir, "fixtures/browser-entrypoints.ts"),
        "--target",
        "browser",
        "--conditions",
        "eliza-source",
        "--outdir",
        outdir,
        "--entry-naming",
        "[name].mjs",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const browser = await import(join(outdir, "browser-entrypoints.mjs"));
    const input = {
      path: "action",
      leaves: [{ name: "PING", tokens: [12, 7] }],
    };
    const decoded = browser.deserializeTokenTree(
      browser.serializeTokenTree(input),
    );
    expect(decoded.path).toBe(input.path);
    expect(
      decoded.leaves.map((leaf: { tokens: number[] }) => leaf.tokens),
    ).toEqual(input.leaves.map((leaf) => leaf.tokens));
    await expect(
      browser.Tesseract.recognize({ image: "abcd" }),
    ).rejects.toThrow("only available on Android");
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
});
