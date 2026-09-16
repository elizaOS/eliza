/**
 * Keyless coverage that an inbound text attachment flows through the message
 * pipeline to a reply. Runs on the pr-deterministic lane under the model provider;
 * live-inbound-attachment proves a real model reads and summarizes it.
 */

import {
  type RuntimeWithScenarioModelFixtures,
  strictActionRouteFixtures,
} from "@elizaos/testing";
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
