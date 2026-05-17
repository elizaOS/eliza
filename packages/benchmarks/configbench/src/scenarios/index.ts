import type { Scenario } from "../types.js";
import { integrationScenarios } from "./integration.js";
import { pluginConfigScenarios } from "./plugin-config.js";
import { pluginFlowScenarios } from "./plugin-flows.js";
import { pluginLifecycleScenarios } from "./plugin-lifecycle.js";
import { secretsCrudScenarios } from "./secrets-crud.js";
import { secretsSecurityScenarios } from "./secrets-security.js";

export const ALL_SCENARIOS: Scenario[] = [
  ...secretsCrudScenarios,
  ...secretsSecurityScenarios,
  ...pluginLifecycleScenarios,
  ...pluginConfigScenarios,
  ...pluginFlowScenarios,
  ...integrationScenarios,
];
