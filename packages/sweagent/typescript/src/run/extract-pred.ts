/**
 * If for some reason the .pred file isn't saved, we can extract it from the .traj file
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Extract prediction from trajectory file
 */
export function extractPred(trajPath: string): void {
  const data = JSON.parse(fs.readFileSync(trajPath, 'utf-8'));
  const predPath = trajPath.replace(/\.traj$/, '.pred');

  const predData = {
    model_name_or_path: path.basename(path.dirname(path.dirname(trajPath))),
    model_patch: data.info?.submission || null,
    instance_id: path.basename(path.dirname(trajPath)),
  };

  fs.writeFileSync(predPath, JSON.stringify(predData));
  console.log(`Extracted prediction to ${predPath}`);
}
