/**
 * The generated project app must consume the same canonical brand env alias
 * helper as packages/app. A local suffix table here will drift from runtime
 * aliases and silently omit security or port keys in newly scaffolded apps.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));

describe("project template brand env aliases", () => {
  it("delegates to the shared canonical alias helper", () => {
    const brandEnv = readFileSync(
      resolve(here, "../../templates/project/apps/app/src/brand-env.ts"),
      "utf8",
    );

    expect(brandEnv).toContain('from "@elizaos/shared"');
    expect(brandEnv).toContain("buildBrandEnvAliases");
    expect(brandEnv).toContain("normalizeBrandEnvPrefix");
    expect(brandEnv).not.toContain("ENV_ALIAS_SUFFIXES");
  });
});
