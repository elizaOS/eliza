import { logger } from '@elizaos/core';
import express from 'express';
import { parseEnvFile, getGlobalEnvPath } from '@/src/commands/env';
import path from 'node:path';
import { existsSync } from 'fs';

function findUpFile(filename: string, startDir: string = process.cwd()): string | null {
  let currentDir = startDir;

  while (true) {
    const fullPath = path.join(currentDir, filename);
    if (existsSync(fullPath)) return fullPath;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null; // Reached root
    }
    currentDir = parentDir;
  }
}

function getLocalEnvPath(): string | null {
  const envPath = findUpFile('.env');
  return envPath;
}

export function envRouter(): express.Router {
  const router = express.Router();

  router.get('/local', async (req, res) => {
    try {
      const localEnvPath = getLocalEnvPath();
      const localEnvs = await parseEnvFile(localEnvPath);

      res.json({
        success: true,
        data: localEnvs,
      });
    } catch (error) {
      logger.error(`[ENVS GET] Error retrieving local envs`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to retrieve local envs',
          details: error.message,
        },
      });
    }
  });

  router.get('/global', async (req, res) => {
    try {
      const globalEnvPath = await getGlobalEnvPath();
      const globalEnvs = await parseEnvFile(globalEnvPath);

      res.json({
        success: true,
        data: globalEnvs,
      });
    } catch (error) {
      logger.error(`[ENVS GET] Error retrieving global envs`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to retrieve global envs',
          details: error.message,
        },
      });
    }
  });

  return router;
}
