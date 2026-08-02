/**
 * Guards the LifeOps provider mock coverage ledger. Existing historical
 * validation-path drift is listed explicitly so new drift fails mechanically
 * while the backlog can burn down the acknowledged missing files one by one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LIFEOPS_PROVIDER_MOCK_COVERAGE,
  REQUIRED_LIFEOPS_PROVIDER_IDS,
} from "../helpers/provider-coverage.ts";
import { MOCK_ENVIRONMENTS } from "../scripts/start-mocks.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

const LEGACY_MISSING_VALIDATION_PATHS = new Set([
  "test/mocks/__tests__/google-calendar-mock.test.ts",
  "plugins/plugin-personal-assistant/test/lifeops-simulator.test.ts",
  "test/mocks/__tests__/non-google-provider-mocks.test.ts",
  "plugins/plugin-personal-assistant/src/actions/search-across-channels.test.ts",
  "test/mocks/__tests__/mock-runtime-seeding.test.ts",
  "plugins/plugin-personal-assistant/test/whatsapp.test.ts",
  "plugins/plugin-telegram/src/local-client.test.ts",
  "plugins/plugin-personal-assistant/src/lifeops/service-mixin-telegram.test.ts",
  "plugins/plugin-personal-assistant/test/cross-channel-send.test.ts",
  "plugins/plugin-personal-assistant/src/lifeops/service-mixin-signal.test.ts",
  "plugins/plugin-personal-assistant/test/discord-browser-scraper.test.ts",
  "plugins/plugin-personal-assistant/test/lifeops-discord-browser-companion.test.ts",
  "plugins/plugin-personal-assistant/test/imessage.test.ts",
  "plugins/plugin-personal-assistant/src/lifeops/imessage-bridge.test.ts",
  "test/mocks/__tests__/mock-runtime.smoke.test.ts",
  "plugins/plugin-personal-assistant/test/twilio-sms.test.ts",
  "plugins/plugin-personal-assistant/test/twilio-call.test.ts",
  "plugins/plugin-personal-assistant/test/calendly.test.ts",
]);

function resolveValidationPath(entry: string): string | null {
  const candidates = [
    path.resolve(repoRoot, entry),
    entry.startsWith("test/")
      ? path.resolve(repoRoot, "packages", entry)
      : null,
    entry.startsWith("../") ? path.resolve(repoRoot, entry.slice(3)) : null,
    path.resolve(repoRoot, "packages/test", entry),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

describe("provider coverage contract", () => {
  it("lists exactly the required LifeOps provider ids once", () => {
    const actual = LIFEOPS_PROVIDER_MOCK_COVERAGE.map((entry) => entry.id);
    expect(new Set(actual).size).toBe(actual.length);
    expect([...actual].sort()).toEqual(
      [...REQUIRED_LIFEOPS_PROVIDER_IDS].sort(),
    );
  });

  it("keeps environments, surfaces, gaps, and validation paths auditable", () => {
    const environments = new Set(MOCK_ENVIRONMENTS);
    const unexpectedMissing: string[] = [];
    const staleAllowlist: string[] = [];

    for (const entry of LIFEOPS_PROVIDER_MOCK_COVERAGE) {
      if (entry.environment !== null) {
        expect(environments.has(entry.environment)).toBe(true);
      }
      expect(entry.surfaces.length, `${entry.id} surfaces`).toBeGreaterThan(0);
      expect(entry.knownGaps.length, `${entry.id} knownGaps`).toBeGreaterThan(
        0,
      );

      for (const validationPath of entry.validation) {
        const resolved = resolveValidationPath(validationPath);
        if (!resolved && !LEGACY_MISSING_VALIDATION_PATHS.has(validationPath)) {
          unexpectedMissing.push(validationPath);
        }
        if (resolved && LEGACY_MISSING_VALIDATION_PATHS.has(validationPath)) {
          staleAllowlist.push(validationPath);
        }
      }
    }

    expect(unexpectedMissing).toEqual([]);
    expect(staleAllowlist).toEqual([]);
  });
});
