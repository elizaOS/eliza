/** Android bundles LifeOps; the collector selects it unless a kill switch applies. */
import { afterEach, expect, it, vi } from "vitest";
import { collectPluginNames } from "../src/runtime/plugin-collector.ts";

const PA = "@elizaos/plugin-personal-assistant";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("selects LifeOps on Android and lets it register calendar and goals itself", () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  const loaded = collectPluginNames({});
  expect(loaded.has(PA)).toBe(true);
  expect(loaded.has("@elizaos/plugin-calendar")).toBe(false);
  expect(loaded.has("@elizaos/plugin-goals")).toBe(false);
});

it("drops LifeOps on Android for store builds, the env kill switch and config opt-out", () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  vi.stubEnv("ELIZA_BUILD_VARIANT", "store");
  expect(collectPluginNames({}).has(PA)).toBe(false);
  vi.stubEnv("ELIZA_BUILD_VARIANT", "");
  vi.stubEnv("ELIZA_DISABLE_PERSONAL_ASSISTANT", "1");
  expect(collectPluginNames({}).has(PA)).toBe(false);
  vi.stubEnv("ELIZA_DISABLE_PERSONAL_ASSISTANT", "");
  expect(
    collectPluginNames({
      plugins: { entries: { "personal-assistant": { enabled: false } } },
    }).has(PA),
  ).toBe(false);
});

it("keeps LifeOps off iOS, which does not bundle it", () => {
  vi.stubEnv("ELIZA_PLATFORM", "ios");
  expect(
    collectPluginNames({
      plugins: { entries: { "personal-assistant": { enabled: true } } },
    }).has(PA),
  ).toBe(false);
});
