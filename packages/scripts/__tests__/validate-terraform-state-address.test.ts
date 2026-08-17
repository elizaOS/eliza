/**
 * Executable contract for protected Terraform state-address validation, using
 * the real CLI boundary that the Infrastructure workflow invokes.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isSafeTerraformStateAddress } from "../validate-terraform-state-address.mjs";

const scriptPath = fileURLToPath(
  new URL("../validate-terraform-state-address.mjs", import.meta.url),
);

function runValidator(addresses: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...addresses], {
    encoding: "utf8",
  });
}

describe("Terraform state address validator", () => {
  test("accepts exact resource instances used by protected state repair", () => {
    const accepted = [
      'cloudflare_dns_record.pages["legacy_blob"]',
      'cloudflare_dns_record.canonical_edge_wildcard["*.sites-staging.eliza.app|216.150.1.193"]',
      'module.edge["staging"].cloudflare_dns_record.pages[0]',
      "data.cloudflare_zone.primary",
    ];

    for (const address of accepted) {
      expect(isSafeTerraformStateAddress(address)).toBe(true);
      const result = runValidator([address]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Validated exact Terraform state address shape.",
      );
      expect(result.stderr).toBe("");
    }
  });

  test("rejects malformed, multiple, option-like, and shell-shaped inputs", () => {
    const rejected = [
      "",
      "-lock=false",
      'cloudflare_dns_record.pages["legacy blob"]',
      'cloudflare_dns_record.pages["legacy_blob"]; terraform destroy',
      'cloudflare_dns_record.pages["$(touch nope)"]',
      "cloudflare_dns_record.pages[../../state]",
      'cloudflare_dns_record.pages["legacy_blob"] other.resource.name',
      "module.edge.",
    ];

    for (const address of rejected) {
      expect(isSafeTerraformStateAddress(address)).toBe(false);
      const result = runValidator([address]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Terraform state address must be one absolute resource-instance address",
      );
      if (address) expect(result.stderr).not.toContain(address);
    }

    expect(runValidator([]).status).toBe(1);
    expect(
      runValidator([
        'cloudflare_dns_record.pages["legacy_blob"]',
        "cloudflare_dns_record.other",
      ]).status,
    ).toBe(1);
  });
});
