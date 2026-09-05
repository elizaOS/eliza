/** Proves the production pinned-Bun preload guard blocks forbidden child egress. */

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("production Bun preload blocks a child fetch before external egress", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-network-guard-"));
  try {
    const ledger = path.join(directory, "ledger.jsonl");
    const guard = path.resolve(
      import.meta.dirname,
      "../../scripts/stability-network-guard.mjs",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        guard,
        "-e",
        'await fetch("https://example.com/forbidden")',
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          ELIZA_STABILITY_CHILD_NETWORK_LEDGER: ledger,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).not.toBe(0);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain(
      "stability network policy blocked https://example.com",
    );
    const entry = JSON.parse((await readFile(ledger, "utf8")).trim()) as {
      at: string;
      origin: string;
      method: string;
      allowed: boolean;
    };
    expect(entry).toEqual({
      at: expect.any(String),
      origin: "https://example.com",
      method: "GET",
      allowed: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
