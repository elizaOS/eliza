import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LIFEOPS_PROVIDER_MOCK_COVERAGE,
  REQUIRED_LIFEOPS_PROVIDER_IDS,
} from "../helpers/provider-coverage.ts";
import { MOCK_ENVIRONMENTS, startMocks } from "../scripts/start-mocks.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const ENVIRONMENTS_DIR = path.resolve(PROJECT_ROOT, "test/mocks/environments");
const README_PATH = path.resolve(PROJECT_ROOT, "test/mocks/README.md");

function readMockEnvironment(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(ENVIRONMENTS_DIR, `${name}.json`), "utf8"),
  ) as Record<string, unknown>;
}

describe("LifeOps provider mock coverage contract", () => {
  it("tracks every required LifeOps provider in one executable registry", () => {
    const coveredIds = LIFEOPS_PROVIDER_MOCK_COVERAGE.map((entry) => entry.id);

    expect(new Set(coveredIds).size).toBe(coveredIds.length);
    expect(coveredIds).toEqual([...REQUIRED_LIFEOPS_PROVIDER_IDS]);
  });

  it("claims every startMocks environment and maps HTTP mocks to env vars", () => {
    const claimedEnvironments = new Set(
      LIFEOPS_PROVIDER_MOCK_COVERAGE.flatMap((entry) =>
        entry.environment ? [entry.environment] : [],
      ),
    );

    expect([...claimedEnvironments].sort()).toEqual(
      [...MOCK_ENVIRONMENTS].sort(),
    );

    for (const entry of LIFEOPS_PROVIDER_MOCK_COVERAGE) {
      if (entry.environment === null) continue;

      expect(MOCK_ENVIRONMENTS).toContain(entry.environment);
      expect(entry.envVars.length).toBeGreaterThan(0);
      expect(
        fs.existsSync(path.join(ENVIRONMENTS_DIR, `${entry.environment}.json`)),
      ).toBe(true);

      const environment = readMockEnvironment(entry.environment);
      expect(environment.name).toEqual(expect.any(String));
      expect(environment.routes).toEqual(expect.any(Array));
    }
  });

  it("emits every registry env var from the real mock runner", async () => {
    for (const environment of MOCK_ENVIRONMENTS) {
      const providers = LIFEOPS_PROVIDER_MOCK_COVERAGE.filter(
        (entry) => entry.environment === environment,
      );
      expect(providers.length).toBeGreaterThan(0);

      const mocks = await startMocks({ envs: [environment] });
      try {
        for (const provider of providers) {
          for (const envVar of provider.envVars) {
            expect(
              mocks.envVars[envVar],
              `${provider.id} declares ${envVar}, but startMocks(${environment}) did not emit it`,
            ).toEqual(expect.any(String));
            expect(mocks.envVars[envVar].length).toBeGreaterThan(0);
          }
        }
      } finally {
        await mocks.stop();
      }
    }
  });

  it("documents non-HTTP seams and known provider gaps", () => {
    for (const entry of LIFEOPS_PROVIDER_MOCK_COVERAGE) {
      expect(entry.surfaces.length).toBeGreaterThan(0);
      expect(entry.knownGaps.length).toBeGreaterThan(0);
      expect(entry.validation.length).toBeGreaterThan(0);

      if (entry.environment === null) {
        expect(entry.rationale).toEqual(expect.any(String));
        expect(entry.rationale?.length ?? 0).toBeGreaterThan(40);
        expect(entry.envVars).toHaveLength(0);
      }
    }
  });

  it("points every provider entry at existing validation files", () => {
    for (const entry of LIFEOPS_PROVIDER_MOCK_COVERAGE) {
      for (const relativePath of entry.validation) {
        expect(
          fs.existsSync(path.resolve(PROJECT_ROOT, relativePath)),
          `${entry.id} validation file is missing: ${relativePath}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the README coverage table synchronized with the registry", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");

    expect(readme).toContain("## Provider coverage and remaining gaps");
    for (const entry of LIFEOPS_PROVIDER_MOCK_COVERAGE) {
      expect(readme).toContain(`\`${entry.id}\``);
      for (const gap of entry.knownGaps) {
        expect(readme).toContain(gap);
      }
    }
  });
});
