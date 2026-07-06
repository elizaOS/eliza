/**
 * Guards the eliza plugin's service registrations (#14710 residual): core
 * PairingService must ship with the default agent, because the connectors'
 * default DM policy is "pairing" and checkPairingAllowed fails CLOSED when the
 * service is missing — an agent without it silently denies every DM and offers
 * no pairing path.
 *
 * eliza-plugin.ts is read as TEXT (not imported) so vitest never eagerly
 * resolves its transitive optional-plugin action imports — the same technique
 * core-static-plugin-registrations.test.ts uses for eliza.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function servicesBlock(): string {
  const source = readFileSync(path.join(here, "eliza-plugin.ts"), "utf8");
  const match = source.match(/services:\s*\[([^\]]*)\]/);
  if (!match) {
    throw new Error("eliza-plugin.ts no longer declares a services array");
  }
  return match[1];
}

describe("createElizaPlugin service registrations", () => {
  it("registers PairingService so the default 'pairing' DM policy is operable", () => {
    expect(servicesBlock()).toContain("PairingService");
  });

  it("keeps OwnerBindingService registered ahead of connector pairing commands", () => {
    expect(servicesBlock()).toContain("OwnerBindingService");
  });
});
