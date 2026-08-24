/** Verifies the production evidence orchestrator fails before corpus work on incomplete or fixture-shaped plans. */

import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS,
  parseProductionArgs,
  resolveProductionCommit,
  validateProductionPlan,
} from "../produce-content-context.mjs";
import { parsePostgresEvidenceArgs } from "../produce-content-context-postgres.mjs";

describe("produce-content-context", () => {
  it("requires explicit production plan, external artifacts, and canonical run root", () => {
    expect(() => parseProductionArgs([])).toThrow(/--plan is required/u);
    expect(() =>
      parseProductionArgs([
        "--plan=p",
        "--external-dir=e",
        "--run-root=r",
        "--profile=micro",
      ]),
    ).toThrow(/scale corpus/u);
  });

  it("rejects missing, duplicate, and fixture-shaped subproducer declarations", () => {
    expect(() =>
      validateProductionPlan({
        schemaVersion: "elizaos.content-context.producers.v1",
        producers: [],
      }),
    ).toThrow(/missing deterministic/u);
    const producers = DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS.map(
      (artifact) => ({ artifact, command: "bun", args: ["run", artifact] }),
    );
    expect(
      validateProductionPlan({
        schemaVersion: "elizaos.content-context.producers.v1",
        producers,
      }),
    ).toHaveLength(DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS.length);
    expect(() =>
      validateProductionPlan({
        schemaVersion: "elizaos.content-context.producers.v1",
        producers: [...producers, producers[0]],
      }),
    ).toThrow(/duplicated/u);
    expect(() =>
      validateProductionPlan({
        schemaVersion: "elizaos.content-context.producers.v1",
        producers: producers.map((entry, index) =>
          index === 0 ? { ...entry, command: "" } : entry,
        ),
      }),
    ).toThrow(/invalid/u);
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
