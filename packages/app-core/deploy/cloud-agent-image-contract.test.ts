/**
 * Verifies the cloud-agent image preserves one explicit ESM entrypoint across
 * its build, runtime copy, and Node command boundaries.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  new URL("./Dockerfile.cloud-agent", import.meta.url),
  "utf8",
);

describe("cloud-agent image module contract", () => {
  it("runs the emitted ESM bundle under an explicit .mjs module scope", () => {
    const buildOutput = dockerfile.match(/--outfile=(entrypoint\.[a-z]+)/)?.[1];
    const runtimeCopy = dockerfile.match(
      /COPY --from=entrypoint-build \/build\/(entrypoint\.[a-z]+) \.\/(entrypoint\.[a-z]+)/,
    );
    const runtimeCommand = dockerfile.match(
      /CMD \["node", "(entrypoint\.[a-z]+)"\]/,
    )?.[1];

    expect(buildOutput).toBe("entrypoint.mjs");
    expect(runtimeCopy?.[1]).toBe(buildOutput);
    expect(runtimeCopy?.[2]).toBe(buildOutput);
    expect(runtimeCommand).toBe(buildOutput);
  });
});
