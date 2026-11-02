import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
for (const environment of ["staging", "production"]) {
  test(`retirement proof has an explicit deployment gate in ${environment}`, () => {
    const block = config.split(`[env.${environment}.vars]`)[1]?.split(/\n\[/)[0];
    expect(block).toBeDefined();
    expect(block).toMatch(/VOICE_SPEECH_RETIREMENT_PROOF_ENABLED\s*=\s*"(?:true|false)"/);
  });
}
