/**
 * File utilities
 * Converted from sweagent/utils/files.py
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Load a file (JSON or YAML)
 */
export function loadFile(filepath: string | null): unknown {
  if (!filepath) {
    return null;
  }

  const ext = path.extname(filepath).toLowerCase();
  const content = fs.readFileSync(filepath, 'utf-8');

  if (ext === '.json') {
    return JSON.parse(content);
  } else if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(content);
  } else {
    // Try to parse as JSON first, then YAML
    try {
      return JSON.parse(content);
    } catch {
      try {
        return yaml.load(content);
      } catch {
        // Return raw content if neither works
        return content;
      }
    }
  }
}
