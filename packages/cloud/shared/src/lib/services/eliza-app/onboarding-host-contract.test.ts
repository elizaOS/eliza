/**
 * Pins the two onboarding frontend ownership contracts. `/get-started` belongs
 * to the homepage; dashboard and billing routes belong to the Cloud app.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function tomlSection(source: string, name: string): string {
  const header = `[${name}]`;
  const headerIndex = source.indexOf(header);
  if (headerIndex < 0) throw new Error(`Missing TOML section ${header}`);

  const body = source.slice(headerIndex + header.length);
  const nextSectionIndex = body.search(/^\[/m);
  return nextSectionIndex < 0 ? body : body.slice(0, nextSectionIndex);
}

describe("Telegram onboarding host deployment contract", () => {
  test("default and production keep login and dashboard origins separate", () => {
    const wrangler = readFileSync(
      join(import.meta.dir, "../../../../../api/wrangler.toml"),
      "utf8",
    );

    for (const section of ["vars", "env.production.vars"]) {
      const vars = tomlSection(wrangler, section);
      expect(vars).toContain('ELIZA_ONBOARDING_LOGIN_APP_URL = "https://eliza.app"');
      expect(vars).toContain('ELIZA_ONBOARDING_APP_URL = "https://app.elizacloud.ai"');
    }
  });
});
