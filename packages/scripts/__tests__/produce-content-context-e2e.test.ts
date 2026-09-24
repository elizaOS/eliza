/** Verifies the real-local E2E collector rejects malformed trace containers and incomplete invocation identity. */

import { describe, expect, it } from "vitest";
import {
  parseContentContextE2EArgs,
  readTraceZipMembers,
} from "../produce-content-context-e2e.mjs";

describe("produce-content-context-e2e", () => {
  it("requires the complete run-bound collector contract", () => {
    const commit = "a".repeat(40);
    const manifest = "b".repeat(64);
    expect(
      parseContentContextE2EArgs([
        `--artifact-root=artifacts`,
        `--out=e2e.json`,
        `--commit=${commit}`,
        `--corpus-manifest-sha256=${manifest}`,
        "--run-id=run-1",
      ]),
    ).toEqual({
      artifactRoot: "artifacts",
      out: "e2e.json",
      commit,
      corpusManifestSha256: manifest,
      runId: "run-1",
    });
    expect(() => parseContentContextE2EArgs(["--artifact-root=only"])).toThrow(
      /--out is required/u,
    );
  });

  it("rejects non-ZIP, truncated, and empty trace containers", () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("not-a-trace"),
      Buffer.from("PK\x05\x06"),
    ]) {
      expect(() => readTraceZipMembers(bytes)).toThrow();
    }
  });
});
