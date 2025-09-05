import type { IAgentRuntime, Route } from '@elizaos/core';
import { logger } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';

// Helper to send success response
function sendSuccess(res: any, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, data }));
}

// Helper to send error response
function sendError(res: any, status: number, code: string, message: string, details?: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: { code, message, details } }));
}

// Handler for the Action Bench frontend panel - serves the React app
async function benchmarksPanelHandler(req: any, res: any, runtime: IAgentRuntime) {
  try {
    logger.info('[ACTION-BENCH PANEL] Serving React Benchmarks UI');

    // Get the current directory (where this routes file is located)
    const currentDir = path.dirname(new URL(import.meta.url).pathname);

    // Path to the built frontend HTML file (same pattern as LiveKit)
    const frontendPath = path.join(currentDir, '../src/frontend/dist/index.html');

    if (fs.existsSync(frontendPath)) {
      const html = await fs.promises.readFile(frontendPath, 'utf8');

      // Transform asset paths to be served from our assets route
      const transformedHtml = html
        .replace(/href="\/assets\//g, 'href="./assets/')
        .replace(/src="\/assets\//g, 'src="./assets/')
        .replace(/from "\/assets\//g, 'from "./assets/')
        .replace(/import "\/assets\//g, 'import "./assets/')
        .replace(/url\(\/assets\//g, 'url(./assets/');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(transformedHtml);
      return;
    } else {
      logger.error('[ACTION-BENCH PANEL] React app not built');
      sendError(
        res, 
        500, 
        'FRONTEND_NOT_BUILT', 
        'React frontend is not built. Run "bun run build" in the frontend directory.',
        `Missing file: ${frontendPath}`
      );
    }
  } catch (error) {
    logger.error('[ACTION-BENCH PANEL] Error serving benchmarks UI:', error instanceof Error ? error.message : String(error));
    sendError(
      res,
      500,
      'PANEL_ERROR',
      'Error serving benchmarks panel',
      error instanceof Error ? error.message : String(error)
    );
  }
}

// Handler for serving static assets (following LiveKit pattern)
async function frontendAssetHandler(req: any, res: any, runtime: IAgentRuntime) {
  try {
    logger.info(`[ACTION-BENCH ASSETS] Serving asset: ${req.path}`);

    // Extract the asset name from the request path
    let assetName = '';
    const assetRequestPath = req.path;
    const assetsMarker = '/assets/';
    const assetsStartIndex = assetRequestPath.indexOf(assetsMarker);

    if (assetsStartIndex !== -1) {
      assetName = assetRequestPath.substring(assetsStartIndex + assetsMarker.length);
    }

    if (!assetName) {
      logger.warn('[ACTION-BENCH ASSETS] No asset name found in path:', assetRequestPath);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Asset not found');
      return;
    }

    // Get the current directory (where this routes file is located)
    const currentDir = path.dirname(new URL(import.meta.url).pathname);

    // Construct the path to the asset
    const assetPath = path.join(currentDir, '../src/frontend/dist/assets', assetName);

    // Check if the asset exists
    if (!fs.existsSync(assetPath)) {
      logger.warn('[ACTION-BENCH ASSETS] Asset not found:', assetPath);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Asset not found');
      return;
    }

    // Determine content type based on file extension
    const ext = path.extname(assetName).toLowerCase();
    let contentType = 'application/octet-stream';

    switch (ext) {
      case '.js':
        contentType = 'application/javascript';
        break;
      case '.css':
        contentType = 'text/css';
        break;
      case '.png':
        contentType = 'image/png';
        break;
      case '.jpg':
      case '.jpeg':
        contentType = 'image/jpeg';
        break;
      case '.svg':
        contentType = 'image/svg+xml';
        break;
      case '.woff':
        contentType = 'font/woff';
        break;
      case '.woff2':
        contentType = 'font/woff2';
        break;
    }

    // Read and serve the asset
    const assetContent = await fs.promises.readFile(assetPath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
    });
    res.end(assetContent);

    logger.info(`[ACTION-BENCH ASSETS] Successfully served: ${assetName}`);
  } catch (error) {
    logger.error('[ACTION-BENCH ASSETS] Error serving asset:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
}

export const actionBenchFrontendRoutes: Route[] = [
  {
    type: 'GET',
    name: 'Benchmarks',
    path: 'action-bench/display',
    handler: benchmarksPanelHandler,
    public: true,
  },
  {
    type: 'GET',
    name: 'Action Bench Assets',
    path: 'action-bench/assets/*',
    handler: frontendAssetHandler,
  },
];
