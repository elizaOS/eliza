/**
 * Remove unfinished trajectories
 */

import * as path from 'path';
import * as fs from 'fs';
import { loadFile } from '../utils/files';
import { getLogger } from '../utils/log';

const logger = getLogger('remove_unfinished');

interface TrajectoryFile {
  info?: {
    submission?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Remove unfinished trajectories
 */
export async function removeUnfinished(baseDir: string, dryRun: boolean = true): Promise<void> {
  const basePath = path.resolve(baseDir);
  const toRemove: string[] = [];

  const directories = fs.readdirSync(basePath);

  for (const dirName of directories) {
    const directory = path.join(basePath, dirName);

    if (!fs.statSync(directory).isDirectory()) {
      continue;
    }

    if (!dirName.includes('__')) {
      continue;
    }

    const trajs = fs
      .readdirSync(directory)
      .filter((file) => file.endsWith('.traj'))
      .map((file) => path.join(directory, file));

    if (trajs.length === 0) {
      logger.info(`No trajectories found in ${directory}`);
      continue;
    }

    if (trajs.length > 1) {
      logger.warn(`Found multiple trajectories in ${directory}. Skipping.`);
      continue;
    }

    try {
      const traj = loadFile(trajs[0]);

      if (!traj || typeof traj !== 'object') {
        logger.warn(`Invalid trajectory format in ${trajs[0]}. Adding to remove list.`);
        toRemove.push(directory);
        continue;
      }

      const submission = (traj as TrajectoryFile).info?.submission || null;

      if (submission === null) {
        logger.warn(`No submission found in ${directory}. Adding to remove list.`);
        toRemove.push(directory);
        continue;
      }
    } catch (error) {
      logger.warn(`Error loading trajectory ${trajs[0]}: ${error}. Adding to remove list.`);
      toRemove.push(directory);
      continue;
    }
  }

  if (dryRun) {
    logger.info(`Would remove ${toRemove.length} unfinished trajectories.`);
    for (const directory of toRemove) {
      logger.info(directory);
    }
  } else {
    for (const directory of toRemove) {
      logger.info(`Removing ${directory}`);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
