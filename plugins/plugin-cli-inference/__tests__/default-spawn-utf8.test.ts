/**
 * Byte-boundary coverage for the shared CLI spawner. The model's reply comes
 * back through the child's stdout pipe in chunks, so a multi-byte code point
 * split across two reads must be reassembled — decoding each chunk on its
 * own turns it into two U+FFFD in the text generate() returns. Real child
 * process (node -e), no mocks: the split is produced by two separate writes.
 */
import { devNull } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultSpawn } from "../src/claude-cli";

const OPTS = {
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "" } as Record<string, string>,
  timeoutMs: 5_000,
  stdinPath: devNull,
};

function splitWriter(stream: "stdout" | "stderr", first: number[], rest: number[]): string {
  return (
    `process.${stream}.write(Buffer.from([${first.join(",")}]));` +
    `setTimeout(()=>{process.${stream}.write(Buffer.from([${rest.join(",")}]));},80);`
  );
}

describe("defaultSpawn decodes child stdio as a UTF-8 stream", () => {
  it("reassembles a two-byte code point split across stdout reads", async () => {
    // "é" is 0xC3 0xA9; the 80ms gap forces two separate pipe reads.
    const result = await defaultSpawn(
      [process.execPath, "-e", splitWriter("stdout", [0xc3], [0xa9])],
      OPTS
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("é");
  });

  it("reassembles a three-byte code point split across stderr reads", async () => {
    // "世" is 0xE4 0xB8 0x96.
    const result = await defaultSpawn(
      [process.execPath, "-e", splitWriter("stderr", [0xe4], [0xb8, 0x96])],
      OPTS
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("世");
  });

  it("leaves whole-chunk ASCII output untouched", async () => {
    const result = await defaultSpawn(
      [process.execPath, "-e", "process.stdout.write('plain text')"],
      OPTS
    );
    expect(result.stdout).toBe("plain text");
  });
});
