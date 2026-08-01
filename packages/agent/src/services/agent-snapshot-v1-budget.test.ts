/**
 * Locks the legacy snapshot producer and restore HTTP boundary to the shared
 * v1 wire ceiling so neither side can drift into producing unrestorable data.
 */

import { AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES } from "@elizaos/shared";
import { describe, expect, test } from "vitest";
import { AGENT_BACKUP_V1_MAX_BODY_BYTES } from "../api/agent-snapshot-routes.ts";
import { AGENT_BACKUP_V1_MAX_SOURCE_BYTES } from "./agent-backup.ts";

describe("agent snapshot v1 budget contract", () => {
  test("producer and restore boundary use the shared restorable ceiling", () => {
    expect(AGENT_BACKUP_V1_MAX_SOURCE_BYTES).toBe(
      AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES,
    );
    expect(AGENT_BACKUP_V1_MAX_BODY_BYTES).toBe(
      AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES,
    );
  });
});
