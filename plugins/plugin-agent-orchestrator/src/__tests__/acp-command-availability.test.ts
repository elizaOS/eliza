import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAcpCommandAvailable } from "../services/acp-command-availability.js";

describe("isAcpCommandAvailable", () => {
  it("rejects a runtime command whose ACP entrypoint is missing", () => {
    expect(
      isAcpCommandAvailable("node /missing/eliza-code-acp.js", {
        env: process.env,
      }),
    ).toBe(false);
  });

  it("accepts an executable whose script entrypoint exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "eliza-acp-command-"));
    const bin = path.join(root, "bin");
    const entrypoint = path.join(root, "acp.js");
    mkdirSync(bin);
    const runtime = path.join(bin, "bun");
    writeFileSync(runtime, "#!/bin/sh\n", "utf8");
    chmodSync(runtime, 0o700);
    writeFileSync(entrypoint, "", "utf8");

    expect(
      isAcpCommandAvailable(`bun "${entrypoint}"`, {
        cwd: root,
        env: { PATH: bin },
      }),
    ).toBe(true);
  });
});
