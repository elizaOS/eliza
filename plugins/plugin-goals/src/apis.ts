import {
  ChannelType,
  type IAgentRuntime,
  type Room,
  type Route,
  type UUID,
  type World,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { sql } from 'drizzle-orm';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGoalDataService } from './services/goalDataService.js';

// Define the equivalent of __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the path to the frontend distribution directory, assuming it's in 'dist'
// relative to the package root (which is two levels up from src/plugin-todo)
const frontendDist = path.resolve(__dirname, '../dist');

const frontPagePath = path.resolve(frontendDist, 'index.html');
const assetsPath = path.resolve(frontendDist, 'assets');
console.log('*** frontPagePath', frontPagePath);
console.log('*** assetsPath', assetsPath);
/**
 * Definition of routes with type, path, and handler for each route.
 * Routes include fetching trending tokens, wallet information, tweets, sentiment analysis, and signals.
 */

export const routes: Route[] = [
  {
    type: 'GET',
    path: '/',
    handler: async (_req: any, res: any, _runtime: IAgentRuntime) => {
      const indexPath = path.resolve(frontendDist, 'index.html');
      if (fs.existsSync(indexPath)) {
        const htmlContent = fs.readFileSync(indexPath, 'utf-8');
        // Set Content-Type header to text/html
        res.setHeader('Content-Type', 'text/html');
        res.send(htmlContent);
      } else {
        res.status(404).send('HTML file not found');
      }
    },
  },
  {
    type: 'GET',
    path: '/goals',
    handler: async (_req: any, res: any, _runtime: IAgentRuntime) => {
      const goalsHtmlPath = path.resolve(frontendDist, 'index.html');
      if (fs.existsSync(goalsHtmlPath)) {
        const htmlContent = fs.readFileSync(goalsHtmlPath, 'utf-8');
        // Set Content-Type header to text/html
        res.setHeader('Content-Type', 'text/html');
        res.send(htmlContent);
      } else {
        res.status(404).send('Goals HTML file not found');
      }
    },
  },
  // Route to serve JS files from frontendDist/assets
  {
    type: 'GET',
    path: '/assets/*',
    handler: async (req: any, res: any, _runtime: IAgentRuntime) => {
      // Extract the relative path after '/assets/'
      const assetRelativePath = req.params[0]; // This captures everything after '/assets/'
      if (!assetRelativePath) {
        return res.status(400).send('Invalid asset path');
      }
      // Construct the full path to the asset within the frontendDist/assets directory
      const filePath = path.resolve(assetsPath, assetRelativePath); // Corrected base path

      // Basic security check to prevent path traversal
      if (!filePath.startsWith(assetsPath)) {
        return res.status(403).send('Forbidden');
      }

      // Check if the file exists and serve it
      if (fs.existsSync(filePath)) {
        // Let express handle MIME types based on file extension
        res.sendFile(filePath);
      } else {
        res.status(404).send('Asset not found');
      }
    },
  },

  // API route to get all tags
  {
    type: 'GET',
    path: '/api/tags',
    handler: async (_req: any, res: any, runtime: IAgentRuntime) => {
      try {
        logger.debug('[API /api/tags] Fetching all distinct tags');

        // Use runtime.db which should be the Drizzle instance from the adapter
        if (!runtime.db || typeof runtime.db.execute !== 'function') {
          logger.error('[API /api/tags] runtime.db is not available or not a Drizzle instance.');
          return res.status(500).json({ error: 'Database not available' });
        }

        // Detect database type
        let dbType: 'sqlite' | 'postgres' | 'unknown' = 'unknown';
        try {
          // Try PostgreSQL detection
          const connection = await runtime.getConnection();
          if (connection && connection.constructor.name === 'Pool') {
            dbType = 'postgres';
          } else {
            // Try SQLite detection
            try {
              await runtime.db.execute(sql`SELECT sqlite_version()`);
              dbType = 'sqlite';
            } catch {
              // Not SQLite
            }
          }
        } catch (error) {
          logger.warn('Could not determine database type:', error);
        }

        let result: any;

        if (dbType === 'postgres') {
          // PostgreSQL query using unnest
          const query = sql`SELECT DISTINCT unnest(tags) as tag FROM goal_tags WHERE tag IS NOT NULL;`;
          result = await runtime.db.execute(query);
        } else {
          // SQLite-compatible query
          const query = sql`
            SELECT DISTINCT tag 
            FROM goal_tags 
            WHERE tag IS NOT NULL
          `;
          result = await runtime.db.execute(query);
        }

        // Drizzle's execute might return results differently depending on the driver
        // Adapting for common patterns (e.g., pg driver returning 'rows')
        const tags = Array.isArray(result)
          ? result.map((row: any) => row.tag)
          : (result as any).rows // Node-postgres likely returns object with 'rows'
            ? (result as any).rows.map((row: any) => row.tag)
            : [];

        logger.debug(`[API /api/tags] Found ${tags.length} distinct tags`);
        res.json(tags);
      } catch (error) {
        logger.error('[API /api/tags] Error fetching tags:', error);
        res.status(500).json({ error: 'Failed to fetch tags' });
      }
    },
  },

  // API route to get all goals by world and rooms
  {
    type: 'GET',
    path: '/api/goals',
    handler: async (req: any, res: any, runtime: IAgentRuntime) => {
      // ... existing code ...
    },
  },
  // API route to create a new goal
  {
    type: 'POST',
    path: '/api/goals',
    handler: async (req: any, res: any, runtime: IAgentRuntime) => {
      try {
        const { name, description, tags } = req.body;

        if (!name) {
          return res.status(400).send('Missing required field: name');
        }

        const dataService = createGoalDataService(runtime);

        const newGoalId = await dataService.createGoal({
          agentId: runtime.agentId,
          ownerType: 'agent',
          ownerId: runtime.agentId,
          name,
          description: description || name,
          metadata: {},
          tags: tags || ['GOAL'],
        });

        const newGoal = newGoalId ? await dataService.getGoal(newGoalId) : null;
        res.status(201).json(newGoal);
      } catch (error) {
        console.error('Error creating goal:', error);
        res.status(500).send('Error creating goal');
      }
    },
  },
  // API route to complete a goal
  {
    type: 'PUT',
    path: '/api/goals/:id/complete',
    handler: async (req: any, res: any, runtime: IAgentRuntime) => {
      try {
        const goalId = req.params.id;

        if (!goalId) {
          return res.status(400).send('Missing goalId');
        }

        const dataService = createGoalDataService(runtime);
        const goal = await dataService.getGoal(goalId);

        if (!goal) {
          return res.status(404).send('Goal not found');
        }

        // Check if already completed
        if (goal.isCompleted) {
          return res.status(400).send('Goal already completed');
        }

        const now = new Date();

        // Update the goal
        await dataService.updateGoal(goalId, {
          isCompleted: true,
          completedAt: now,
          metadata: {
            ...goal.metadata,
            completedAt: now.toISOString(),
          },
        });

        // Return the final goal state
        const updatedGoal = await dataService.getGoal(goalId);
        res.json({
          message: `Goal ${goalId} completed.`,
          goal: updatedGoal,
        });
      } catch (error: any) {
        console.error(`Error completing goal ${req.params.id}:`, error);
        logger.error(`Error completing goal ${req.params.id}:`, error);
        res.status(500).send(`Error completing goal: ${error.message}`);
      }
    },
  },
  // API route to uncomplete a goal
  {
    type: 'PUT',
    path: '/api/goals/:id/uncomplete',
    handler: async (req: any, res: any, runtime: IAgentRuntime) => {
      try {
        const goalId = req.params.id;
        if (!goalId) {
          return res.status(400).send('Missing goalId');
        }

        const dataService = createGoalDataService(runtime);
        const goal = await dataService.getGoal(goalId);

        if (!goal) {
          return res.status(404).send('Goal not found');
        }

        // Check if already incomplete
        if (!goal.isCompleted) {
          return res.status(400).send('Goal is already not completed');
        }

        // Update the goal
        const metadataUpdate = { ...goal.metadata };
        delete metadataUpdate.completedAt;

        await dataService.updateGoal(goalId, {
          isCompleted: false,
          completedAt: undefined,
          metadata: metadataUpdate,
        });

        const updatedGoal = await dataService.getGoal(goalId);
        res.json({
          message: `Goal ${goalId} marked as not completed.`,
          goal: updatedGoal,
        });
      } catch (error: any) {
        console.error(`Error uncompleting goal ${req.params.id}:`, error);
        logger.error(`Error uncompleting goal ${req.params.id}:`, error);
        res.status(500).send(`Error uncompleting goal: ${error.message}`);
      }
    },
  },
  // API route to update an existing goal
  {
    type: 'PUT',
    path: '/api/goals/:id',
    handler: async (req: any, res: any, runtime: IAgentRuntime) => {
      try {
        const goalId = req.params.id;
        const updateData = req.body;

        if (!goalId) {
          return res.status(400).send('Missing goal ID');
        }
        if (!updateData || Object.keys(updateData).length === 0) {
          return res.status(400).send('Missing update data');
        }

        const dataService = createGoalDataService(runtime);
        const goal = await dataService.getGoal(goalId);

        if (!goal) {
          return res.status(404).send('Goal not found');
        }

        // Apply updates
        const updates: any = {};
        if (updateData.name) updates.name = updateData.name;
        if (updateData.description !== undefined) updates.description = updateData.description;
        if (updateData.tags) updates.tags = updateData.tags;
        if (updateData.metadata) updates.metadata = { ...goal.metadata, ...updateData.metadata };

        await dataService.updateGoal(goalId, updates);

        const updatedGoal = await dataService.getGoal(goalId);
        res.json({
          message: `Goal ${goalId} updated successfully.`,
          goal: updatedGoal,
        });
      } catch (error: any) {
        console.error(`Error updating goal ${req.params.id}:`, error);
        logger.error(`Error updating goal ${req.params.id}:`, error);
        res.status(500).send(`Error updating goal: ${error.message}`);
      }
    },
  },
  // API route to delete a goal
  {
    type: 'DELETE',
    path: '/api/goals/:id',
    handler: async (req: any, res: any, runtime: IAgentRuntime) => {
      try {
        const goalId = req.params.id;
        if (!goalId) {
          return res.status(400).send('Missing goal ID');
        }

        const dataService = createGoalDataService(runtime);
        const goal = await dataService.getGoal(goalId);

        if (!goal) {
          return res.status(404).send('Goal not found');
        }

        await dataService.deleteGoal(goalId);

        res.json({
          message: `Goal ${goalId} deleted successfully.`,
        });
      } catch (error) {
        console.error(`Error deleting goal ${req.params.id}:`, error);
        logger.error(`Error deleting goal ${req.params.id}:`, error);
        res.status(500).send('Error deleting goal');
      }
    },
  },
];

export default routes;

// TaskUpdate interface for API updates
interface TaskUpdate {
  name?: string;
  description?: string;
  priority?: 1 | 2 | 3 | 4;
  urgent?: boolean;
  dueDate?: string | null; // Expect ISO string or null
  recurring?: 'daily' | 'weekly' | 'monthly';
}
