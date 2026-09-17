/**
 * Keyless catalog coverage for the plugin-github action and route surface against
 * a mocked GitHub API. Runs on the pr-deterministic lane under the model provider.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import {
  type DeterministicModelFixture,
  finalMessageUserText,
  type RuntimeWithScenarioModelFixtures,
  registerStrictActionRouteFixtures,
  strictActionRouteFixtures,
} from "@elizaos/testing";
