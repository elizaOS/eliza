/**
 * Common utilities for run module
 * Converted from sweagent/run/common.py
 */

import path from 'path';
import fs from 'fs';
import { AgentInfo, AgentRunResult } from '../types';

/**
 * Shorten a string to a maximum length
 */
export function shortenString(s: string, maxLength: number, shortenLeft: boolean = false): string {
  if (s.length <= maxLength) {
    return s;
  }

  if (shortenLeft) {
    return '...' + s.slice(s.length - maxLength + 3);
  } else {
    return s.slice(0, maxLength - 3) + '...';
  }
}

/**
 * Shorten strings in a nested object/array
 */
export function shortenStrings(data: unknown, maxLength: number = 30): unknown {
  if (typeof data === 'string') {
    return shortenString(data, maxLength);
  }

  if (Array.isArray(data)) {
    return data.map((item) => shortenStrings(item, maxLength));
  }

  if (data && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = shortenStrings(value, maxLength);
    }
    return result;
  }

  return data;
}

/**
 * Save predictions from agent run result
 */
export function savePredictions(trajDir: string | path.ParsedPath, instanceId: string, result: AgentRunResult): void {
  const dirPath = typeof trajDir === 'string' ? trajDir : path.format(trajDir);
  const predPath = path.join(dirPath, 'predictions.json');

  // Load existing predictions or create new
  let predictions: Record<string, any> = {};
  if (fs.existsSync(predPath)) {
    const content = fs.readFileSync(predPath, 'utf-8');
    predictions = JSON.parse(content);
  }

  // Add/update prediction for this instance
  predictions[instanceId] = {
    model_patch: result.info.submission || '',
    model_name_or_path: result.info.modelStats?.model || 'unknown',
    cost: result.info.modelStats?.instanceCost || 0,
    api_calls: result.info.modelStats?.apiCalls || 0,
    instance_id: instanceId,
  };

  // Save predictions
  fs.writeFileSync(predPath, JSON.stringify(predictions, null, 2));
}

/**
 * Check if a patch is promising (not empty/trivial)
 */
export function isPromisingPatch(info: AgentInfo): boolean {
  const submission = info.submission;

  if (!submission || typeof submission !== 'string') {
    return false;
  }

  // Check if patch is empty or only whitespace
  if (submission.trim() === '') {
    return false;
  }

  // Check if patch only contains diff headers but no actual changes
  const lines = submission.split('\n');
  let hasChanges = false;

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      hasChanges = true;
      break;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      hasChanges = true;
      break;
    }
  }

  return hasChanges;
}

/**
 * Create a nested dictionary structure
 */
export function createNestedDict(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (target: Record<string, unknown>, prop: string) => {
        if (!(prop in target)) {
          target[prop] = createNestedDict();
        }
        return target[prop];
      },
    },
  );
}

/**
 * Parse command-line arguments into nested dictionary
 */
export function parseArgsToNestedDict(args: string[]): Record<string, unknown> {
  const result = createNestedDict();

  for (const arg of args) {
    if (arg.includes('=')) {
      const [keyPath, value] = arg.split('=', 2);
      const keys = keyPath.split('.');

      let current: Record<string, unknown> = result as Record<string, unknown>;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in current)) {
          current[keys[i]] = {};
        }
        current = current[keys[i]] as Record<string, unknown>;
      }

      // Try to parse value as JSON, number, or boolean
      let parsedValue: unknown = value;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        if (value === 'true') {
          parsedValue = true;
        } else if (value === 'false') {
          parsedValue = false;
        } else if (!isNaN(Number(value))) {
          parsedValue = Number(value);
        }
      }

      current[keys[keys.length - 1]] = parsedValue;
    }
  }

  return result;
}
