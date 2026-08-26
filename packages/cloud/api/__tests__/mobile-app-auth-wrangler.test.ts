/** Verifies every deployable Cloud API environment enables native PKCE auth. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wrangler = readFileSync(
  new URL("../wrangler.toml", import.meta.url),
  "utf8",
);

function varsBlock(environment?: "staging" | "production"): string {
  const heading = environment ? `[env.${environment}.vars]` : "[vars]";
  const start = wrangler.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = wrangler.slice(start + heading.length);
  const end = rest.search(/^\[/m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("mobile app auth Wrangler configuration", () => {
  it.each([undefined, "staging", "production"] as const)(
    "enables native PKCE in %s",
    (environment) => {
      expect(varsBlock(environment)).toMatch(
        /^ELIZA_MOBILE_APP_AUTH_ENABLED = "true"$/m,
      );
    },
  );
});
