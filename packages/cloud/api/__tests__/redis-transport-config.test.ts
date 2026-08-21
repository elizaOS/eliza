/** Pins staging-only REST selection while production retains its existing automatic policy. */

import { describe, expect, test } from "bun:test";

const wrangler = await Bun.file(
  new URL("../wrangler.toml", import.meta.url),
).text();

function environmentVars(name: "staging" | "production"): string {
  const start = `[env.${name}.vars]`;
  const startIndex = wrangler.indexOf(start);
  if (startIndex < 0) throw new Error(`missing ${start}`);
  const rest = wrangler.slice(startIndex + start.length);
  const nextEnvironment = rest.search(/\n\[env\.[^.\]]+(?:\.|\])/);
  return nextEnvironment < 0 ? rest : rest.slice(0, nextEnvironment);
}

describe("Worker direct Redis transport config", () => {
  test("staging selects direct REST without changing either environment's cache policy", () => {
    const staging = environmentVars("staging");
    const production = environmentVars("production");

    expect(staging).toContain('CACHE_BACKEND = "auto"');
    expect(staging).toContain('DIRECT_REDIS_BACKEND = "redis-rest"');
    expect(production).toContain('CACHE_BACKEND = "auto"');
    expect(production).not.toContain("DIRECT_REDIS_BACKEND");
  });
});
