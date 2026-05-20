/**
 * Export rubrics to JSON for Python training to consume
 *
 * IMPORTANT: TypeScript rubrics are the source of truth.
 * Run this script whenever rubrics change to sync with Python:
 *   bun run scripts/export-rubrics.ts
 *
 * The generated config/rubrics.json is read by Python's rubric_loader.py
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_PRIORITY_METRICS,
  DEFAULT_RUBRIC,
  getAvailableArchetypes,
  PRIORITY_METRICS,
  RUBRICS,
} from '../src/rubrics';

const outputPath = path.join(__dirname, '../config/rubrics.json');

// Use the canonical list of archetypes (excludes aliases)
const availableArchetypes = getAvailableArchetypes();

// Filter RUBRICS to only include canonical entries (no aliases)
const canonicalRubrics: Record<string, string> = {};
for (const archetype of availableArchetypes) {
  if (RUBRICS[archetype]) {
    canonicalRubrics[archetype] = RUBRICS[archetype];
  }
}

// Filter PRIORITY_METRICS to only include canonical entries
const canonicalPriorityMetrics: Record<string, string[]> = {};
for (const archetype of availableArchetypes) {
  if (PRIORITY_METRICS[archetype]) {
    canonicalPriorityMetrics[archetype] = PRIORITY_METRICS[archetype];
  }
}

const exportData = {
  rubrics: canonicalRubrics,
  priorityMetrics: canonicalPriorityMetrics,
  defaults: {
    rubric: DEFAULT_RUBRIC,
    priorityMetrics: DEFAULT_PRIORITY_METRICS,
  },
  availableArchetypes,
};

// Ensure config directory exists
const configDir = path.dirname(outputPath);
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

fs.writeFileSync(outputPath, `${JSON.stringify(exportData, null, 2)}\n`);
console.log(`✓ Exported rubrics to ${outputPath}`);
console.log(`  - ${Object.keys(canonicalRubrics).length} rubric entries`);
console.log(`  - ${availableArchetypes.length} available archetypes`);
console.log(
  '\nNote: TypeScript rubrics are the source of truth. Run this script after making rubric changes.'
);
