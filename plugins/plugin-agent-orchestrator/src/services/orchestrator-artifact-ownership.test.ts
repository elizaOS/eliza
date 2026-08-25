/**
 * Unit tests for orchestrator-artifact-ownership: validates metadata parser for owned artifacts.
 */
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_OWNED_ARTIFACTS_METADATA_KEY,
  readOwnedArtifactsFromMetadata,
} from "./orchestrator-artifact-ownership.ts";

describe("orchestrator-artifact-ownership", () => {
  it("exports standard metadata key", () => {
    expect(ORCHESTRATOR_OWNED_ARTIFACTS_METADATA_KEY).toBe(
      "orchestratorOwnedArtifacts",
    );
  });

  it("returns empty array for missing or invalid metadata", () => {
    expect(readOwnedArtifactsFromMetadata(undefined)).toEqual([]);
    expect(readOwnedArtifactsFromMetadata({})).toEqual([]);
    expect(
      readOwnedArtifactsFromMetadata({
        orchestratorOwnedArtifacts: "not-an-array",
      }),
    ).toEqual([]);
  });

  it("extracts and validates valid owned artifact records", () => {
    const validRecord = {
      path: "manifest.json",
      sha256: "abc123sha",
      byteLength: 120,
      source: "skills-manifest",
    };
    const records = readOwnedArtifactsFromMetadata({
      orchestratorOwnedArtifacts: [validRecord, { invalid: "record" }],
    });
    expect(records).toEqual([validRecord]);
  });
});
