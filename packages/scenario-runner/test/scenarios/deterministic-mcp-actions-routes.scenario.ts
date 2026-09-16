/**
 * Keyless catalog coverage for the plugin-mcp action and route surface. Runs on
 * the pr-deterministic lane under the model provider.
 */
import { readFileSync } from "node:fs";
import type http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type IAgentRuntime, ModelType, type Plugin } from "@elizaos/core";
import {
  type DeterministicModelCall,
  matchesScenarioInput,
  type RuntimeWithScenarioModelFixtures,
  registerStrictActionRouteFixtures,
  strictActionRouteFixtures,
} from "@elizaos/testing";
