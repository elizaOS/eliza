import { logger } from '@elizaos/core';
import express from 'express';
import { parseEnvFile } from '@/src/commands/env';
import { findNearestEnvFile } from '@/src/utils';
import path from 'node:path';
import { existsSync, writeFileSync } from 'fs';

function serializeEnvObject(envObj: Record<string, string>): string {
  return Object.entries(envObj)
    .map(([key, val]) => `${key}=${val ?? ''}`)
    .join('\n\n');
}

function getLocalEnvPath(): string | null {
  return findNearestEnvFile();
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

  router.post('/local', async (req, res) => {
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
          details: error.message,
        },
      });
    }
  });


  return router;
}
