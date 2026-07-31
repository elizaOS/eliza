/**
 * Pins the workflow to the canonical state-file field written by the Hetzner
 * provisioner so missing or malformed server identifiers fail immediately.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL(
    "../../../../../.github/workflows/hetzner-sleep-wake-smoke.yml",
    import.meta.url,
  ),
  "utf8",
);

describe("Hetzner sleep-wake workflow state contract", () => {
  test("reads both server identifiers strictly from server_id", () => {
    const strictServerIdReads =
      workflow.match(
        /ID_[AB]=\$\(jq -er \.server_id "\$HETZNER_E2E_STATE_FILE"\)/g,
      ) ?? [];

    expect(strictServerIdReads).toHaveLength(2);
    expect(workflow).not.toContain("jq -r .id");
    expect(workflow).not.toContain("jq -er .id");
  });
});
