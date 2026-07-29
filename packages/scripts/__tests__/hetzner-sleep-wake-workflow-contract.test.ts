/**
 * Guards the scheduled sleep-wake workflow's state-file contract.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL(
    "../../../.github/workflows/hetzner-sleep-wake-smoke.yml",
    import.meta.url,
  ),
  "utf8",
);

describe("Hetzner sleep-wake workflow contract", () => {
  test("reads the canonical server_id for both lifecycle boxes", () => {
    expect(workflow.match(/jq -er \.server_id/g)).toHaveLength(2);
    expect(workflow).not.toContain("jq -r .id");
  });
});
