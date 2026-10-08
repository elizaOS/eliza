/** Named staging config must enable incoming disconnects before hosted cancellation QA. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("staging and production effective source flags preserve node compatibility and enable request signals", async () => {
  const config = Bun.TOML.parse(await readFile(new URL("../wrangler.toml", import.meta.url), "utf8")) as {
    compatibility_flags: string[];
    env: Record<string, { compatibility_flags?: string[] }>;
  };
  for (const environment of ["staging", "production"]) {
    const flags = config.env[environment].compatibility_flags ?? config.compatibility_flags;
    expect(flags).toContain("nodejs_compat");
    expect(flags).toContain("enable_request_signal");
  }
});
