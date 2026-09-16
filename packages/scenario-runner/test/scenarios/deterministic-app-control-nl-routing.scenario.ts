/**
 * Keyless coverage that natural-language requests route to the correct
 * plugin-app-control action against seeded scenario views. Runs on the
 * pr-deterministic lane under the model provider (fixtures pin the routing).
 */
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type JsonValue, ModelType } from "@elizaos/core";
import {
  type DeterministicModelFixture,
  matchesScenarioInput,
} from "@elizaos/testing";
