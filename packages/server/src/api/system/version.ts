import express from 'express';

/**
 * Gets version information using CLI-compatible logic
 */
function getVersionInfo() {
  const timestamp = new Date().toISOString();

  try {
    const version = require('@elizaos/server/package.json').version;

    return {
      version,
      timestamp,
      environment: process.env.NODE_ENV || 'development',
      uptime: process.uptime(),
    };
  } catch (error) {
    console.error('Error getting version info:', error);

    return {
      version: 'unknown',
      timestamp,
      environment: process.env.NODE_ENV || 'development',
      uptime: process.uptime(),
      error: 'Failed to retrieve version information',
    };
  }
}

/**
 * Creates the version router for system version information
 */
export function createVersionRouter(): express.Router {
  const router = express.Router();

  // GET /api/system/version - Returns version information
  router.get('/', (_, res) => {
    const versionInfo = getVersionInfo();
    const statusCode = versionInfo.error ? 500 : 200;

    res.status(statusCode).json(versionInfo);
  });

  return router;
}
