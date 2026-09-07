/** Verifies production evidence assembly uses the fixed repository inventory rather than caller commands. */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_DETERMINISTIC_PRODUCER,
  DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS,
  EXTERNAL_CONTENT_CONTEXT_ARTIFACTS,
  parseProductionArgs,
  RUN_BOUND_CONTENT_CONTEXT_ARTIFACTS,
  resolveProductionCommit,
} from "../produce-content-context.mjs";
import { parsePostgresEvidenceArgs } from "../produce-content-context-postgres.mjs";

describe("produce-content-context", () => {
  it("requires the exact run-bound artifact set and canonical run root", () => {
    expect(() => parseProductionArgs([])).toThrow(
      /--external-dir is required/u,
    );
    expect(() =>
      parseProductionArgs([
        "--external-dir=e",
        "--run-root=r",
        "--profile=micro",
      ]),
    ).toThrow(/scale corpus/u);
  });

  it("uses one checked-in exact inventory instead of caller-selected commands", () => {
    expect(RUN_BOUND_CONTENT_CONTEXT_ARTIFACTS).toEqual([
      ...DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS,
      ...EXTERNAL_CONTENT_CONTEXT_ARTIFACTS,
    ]);
    expect(new Set(RUN_BOUND_CONTENT_CONTEXT_ARTIFACTS).size).toBe(
      RUN_BOUND_CONTENT_CONTEXT_ARTIFACTS.length,
    );
    expect(CANONICAL_DETERMINISTIC_PRODUCER).toEqual({
      command: "bun",
      args: ["packages/scripts/produce-content-context-deterministic.mjs"],
    });
    expect(() =>
      parseProductionArgs([
        "--external-dir=e",
        "--run-root=r",
        "--plan=arbitrary.json",
      ]),
    ).toThrow(/unknown argument/u);
  });

  it("resolves an omitted commit to the exact repository head", async () => {
    await expect(resolveProductionCommit(undefined)).resolves.toMatch(
      /^[0-9a-f]{40}$/u,
    );
    await expect(resolveProductionCommit("short")).rejects.toThrow(
      /exact SHA/u,
    );
  });

  it("keeps the Postgres connection environment-only and binds an exact commit", () => {
    const commit = "a".repeat(40);
    expect(parsePostgresEvidenceArgs([`--commit=${commit}`])).toEqual({
      commit,
    });
    expect(() => parsePostgresEvidenceArgs([])).toThrow(/exact Git SHA/u);
    expect(() =>
      parsePostgresEvidenceArgs([
        `--commit=${commit}`,
        "--postgres-url=postgresql://user:secret@example.invalid/db",
      ]),
    ).toThrow(/unknown argument/u);
  });
});
