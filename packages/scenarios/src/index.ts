// Export all example scenarios
export { default as truthVsLieScenario } from './truth-vs-lie';
export { default as researchTaskScenario } from './research-task';
export { default as codingChallengeScenario } from './coding-challenge';
export { default as workflowPlanningScenario } from './workflow-planning';

import { truthVsLieScenario } from './truth-vs-lie';
import { researchTaskScenario } from './research-task';
import { codingChallengeScenario } from './coding-challenge';
import { workflowPlanningScenario } from './workflow-planning';

// Import plugin test scenarios
import { pluginTestScenarios } from './plugin-tests';
export { pluginTestScenarios } from './plugin-tests';

// Import rolodex scenarios
import {
  entityIntroductionScenario,
  relationshipBuildingScenario,
  trustEvolutionScenario,
  complexNetworkScenario,
  followUpManagementScenario,
} from './rolodex';

export {
  entityIntroductionScenario,
  relationshipBuildingScenario,
  trustEvolutionScenario,
  complexNetworkScenario,
  followUpManagementScenario,
} from './rolodex';

// Export individual example scenarios
export const exampleScenarios = [
  truthVsLieScenario,
  researchTaskScenario,
  codingChallengeScenario,
  workflowPlanningScenario,
];

// Rolodex scenarios
export const rolodexScenarios = [
  entityIntroductionScenario,
  relationshipBuildingScenario,
  trustEvolutionScenario,
  complexNetworkScenario,
  followUpManagementScenario,
];

// Export all scenarios including plugin tests
export const allScenarios = [...exampleScenarios, ...pluginTestScenarios, ...rolodexScenarios];

// Default export includes all scenarios
export default allScenarios;

// Array of all built-in scenarios
export const builtInScenarios = [
  truthVsLieScenario,
  researchTaskScenario,
  codingChallengeScenario,
  workflowPlanningScenario,
];

// Export scenarios alias for compatibility
export const scenarios = allScenarios;

// Export test runner and related utilities
export { 
  ConsolidatedScenarioTestRunner, 
  ScenarioManifestValidator,
  runScenarioTests 
} from './test-runner.js';

// Scenario categories
export const scenarioCategories = {
  reasoning: [truthVsLieScenario],
  research: [researchTaskScenario],
  coding: [codingChallengeScenario],
  planning: [workflowPlanningScenario],
  integration: pluginTestScenarios,
  rolodex: rolodexScenarios,
};

// Get scenarios by category
export function getScenariosByCategory(category: string) {
  return scenarioCategories[category as keyof typeof scenarioCategories] || [];
}

// Get scenario by ID
export function getScenarioById(id: string) {
  return allScenarios.find((scenario) => scenario.id === id);
}
