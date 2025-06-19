import { logger } from '@elizaos/core';
import express from 'express';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs/promises';

export type EnvVars = Record<string, string>;

/**
 * Parse an .env file and return the key-value pairs
 * @param filePath Path to the .env file
 * @returns Object containing the key-value pairs
 */
export async function parseEnvFile(filePath: string): Promise<EnvVars> {
  try {
    if (!existsSync(filePath)) {
      return {};
    }

    const content = await fs.readFile(filePath, 'utf-8');
    // Handle empty file case gracefully
    if (content.trim() === '') {
      return {};
    }
    return dotenv.parse(content);
  } catch (error: any) {
    console.error(`Error parsing .env file: ${error.message}`);
    return {};
  }
}

function serializeEnvObject(envObj: Record<string, string>): string {
  return Object.entries(envObj)
    .map(([key, val]) => `${key}=${val ?? ''}`)
    .join('\n\n');
}

function getLocalEnvPath(): string | null {
  const envPath = resolveEnvFile();
  return existsSync(envPath) ? envPath : null;
}

/**
 * Resolves the path to the nearest `.env` file.
 *
 * If no `.env` file is found when traversing up from the starting directory,
 * a path to `.env` in the starting directory is returned.
 *
 * @param startDir - The directory to start searching from. Defaults to the
 *   current working directory.
 * @returns The resolved path to the `.env` file.
 */
export function resolveEnvFile(startDir: string = process.cwd()): string {
  let currentDir = startDir;

  while (true) {
    const candidate = path.join(currentDir, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return path.join(startDir, '.env');
}

/**
 * Environment configuration management
 */
export function createEnvironmentRouter(): express.Router {
  const router = express.Router();

  // Get local environment variables
  (router as any).get('/local', async (_req: express.Request, res: express.Response) => {
    try {
      const localEnvPath = getLocalEnvPath();
      if (!localEnvPath) {
        return res.json({
          success: true,
          data: {},
        });
      }
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
          details: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  // Update local environment variables
  (router as any).post('/local', async (req: express.Request, res: express.Response) => {
    try {
      const { content } = req.body;

      if (!content || typeof content !== 'object') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Missing or invalid "content" in request body',
          },
        });
      }

      const localEnvPath = getLocalEnvPath();
      if (!localEnvPath) throw new Error('Local .env file not found');

      const envString = serializeEnvObject(content);
      writeFileSync(localEnvPath, envString, 'utf-8');

      res.json({
        success: true,
        message: 'Local env updated',
      });
    } catch (error) {
      logger.error(`[ENVS POST] Error updating local envs`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'UPDATE_ERROR',
          message: 'Failed to update local envs',
          details: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  return router;
}
