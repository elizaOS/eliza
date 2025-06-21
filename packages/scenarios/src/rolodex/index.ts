// Rolodex Plugin Scenarios
// These scenarios test entity tracking, relationship building, trust management,
// and follow-up scheduling with multiple agents

export { entityIntroductionScenario } from './entity-introduction';
export { relationshipBuildingScenario } from './relationship-building';
export { trustEvolutionScenario } from './trust-evolution';
export { complexNetworkScenario } from './complex-network';
export { followUpManagementScenario } from './follow-up-management';

// Import the actual scenarios
import { entityIntroductionScenario } from './entity-introduction';
import { relationshipBuildingScenario } from './relationship-building';
import { trustEvolutionScenario } from './trust-evolution';
import { complexNetworkScenario } from './complex-network';
import { followUpManagementScenario } from './follow-up-management';

// Export as array for easy iteration
export const rolodexScenarios = [
  entityIntroductionScenario,
  relationshipBuildingScenario,
  trustEvolutionScenario,
  complexNetworkScenario,
  followUpManagementScenario
];

// Export scenario metadata
export const scenarioMetadata = {
  'entity-introduction': {
    name: 'Entity Introduction and Extraction',
    description: 'Tests basic entity tracking and information extraction with 5 agents',
    agents: 5,
    duration: 20000,
  },
  'relationship-building': {
    name: 'Relationship Building and Evolution',
    description: 'Tests relationship inference and strength tracking with 6 agents',
    agents: 6,
    duration: 25000,
  },
  'trust-evolution': {
    name: 'Trust Evolution and Security',
    description: 'Tests trust scoring and suspicious behavior detection with 7 agents',
    agents: 7,
    duration: 20000,
  },
  'complex-network': {
    name: 'Complex Professional Network',
    description: 'Tests entity resolution and search at scale with 10 agents',
    agents: 10,
    duration: 20000,
  },
  'follow-up-management': {
    name: 'Follow-up Scheduling and Management',
    description: 'Tests follow-up scheduling and tracking with 8 agents',
    agents: 8,
    duration: 20000,
  },
}; 