/**
 * Merge multiple predictions into a single file
 */

import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../utils/log';

const logger = getLogger('merge', '➕');

/**
 * Merge predictions found in directories into a single JSON file
 */
export function mergePredictions(directories: string[], output?: string): void {
  const preds: string[] = [];

  // Find all prediction files
  for (const directory of directories) {
    const predFiles = findPredFiles(directory);
    preds.push(...predFiles);
    logger.debug(`Found ${predFiles.length} predictions in ${directory}`);
  }

  logger.info(`Found ${preds.length} predictions`);

  if (preds.length === 0) {
    logger.warn(`No predictions found in ${directories.join(', ')}`);
    return;
  }

  if (!output) {
    output = path.join(directories[0], 'preds.json');
  }

  const data: Record<string, any> = {};

  for (const pred of preds) {
    const content = fs.readFileSync(pred, 'utf-8');
    const predData = JSON.parse(content);
    const instanceId = predData.instance_id;

    if (!('model_patch' in predData)) {
      logger.warn(`Prediction ${pred} does not contain a model patch. SKIPPING`);
      continue;
    }

    // Ensure model_patch is a string
    predData.model_patch =
      predData.model_patch !== null && predData.model_patch !== undefined ? String(predData.model_patch) : '';

    if (instanceId in data) {
      throw new Error(`Duplicate instance ID found: ${instanceId}`);
    }

    data[instanceId] = predData;
  }

  // Create output directory if it doesn't exist
  const outputDir = path.dirname(output);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(output, JSON.stringify(data, null, 4));
  logger.info(`Wrote merged predictions to ${output}`);
}

/**
 * Recursively find all .pred files in a directory
 */
function findPredFiles(directory: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(directory)) {
    return results;
  }

  function walk(dir: string) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        walk(filePath);
      } else if (file.endsWith('.pred')) {
        results.push(filePath);
      }
    }
  }

  walk(directory);
  return results;
}
