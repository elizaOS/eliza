import express from 'express';

/**
 * Public configuration endpoint
 * Exposes non-sensitive server configuration to the client
 */
export function createConfigRouter(): express.Router {
  const router = express.Router();

  // Get public server configuration
  router.get('/', (_req, res) => {
    const config = {
      // Authentication configuration
      requiresAuth: process.env.ENABLE_DATA_ISOLATION === 'true',

      // Add other public config here as needed
      // features: { ... }
    };

    res.json({
      success: true,
      data: config,
    });
  });

  return router;
}
