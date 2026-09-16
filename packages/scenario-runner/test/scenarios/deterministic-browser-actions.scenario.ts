/**
 * Keyless catalog coverage for the browser-workspace action surface against a
 * seeded browser tab. Runs on the pr-deterministic lane under the model provider.
 */

import {
  type RuntimeWithScenarioModelFixtures,
  registerStrictActionRouteFixtures,
} from "@elizaos/testing";
import type {
  CapturedAction,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { browserPlugin } from "../../../../plugins/plugin-browser/src/plugin.ts";
import {
  __resetBrowserWorkspaceStateForTests,
  ensureBrowserWorkspaceDefaultTab,
  executeBrowserWorkspaceCommand,
} from "../../../../plugins/plugin-browser/src/workspace/browser-workspace.ts";
