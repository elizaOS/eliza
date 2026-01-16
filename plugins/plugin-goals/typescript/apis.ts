import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type IAgentRuntime,
  logger,
  type Route,
  type RouteRequest,
  type RouteResponse,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { createGoalDataService } from "./services/goalDataService.js";

interface TagRow {
  tag: string;
}

interface DbQueryResult {
  rows?: TagRow[];
}

// Define the equivalent of __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the path to the frontend distribution directory, assuming it's in 'dist'
// relative to the package root (which is two levels up from src/plugin-todo)
const frontendDist = path.resolve(__dirname, "../dist");

const _frontPagePath = path.resolve(frontendDist, "index.html");
const assetsPath = path.resolve(frontendDist, "assets");

export const routes: Route[] = [
  {
    type: "GET",
    path: "/",
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const indexPath = path.resolve(frontendDist, "index.html");
      if (fs.existsSync(indexPath)) {
        const htmlContent = fs.readFileSync(indexPath, "utf-8");
        res.setHeader("Content-Type", "text/html");
        res.send(htmlContent);
      } else {
        res.status(404).send("HTML file not found");
      }
    },
  },
  {
    type: "GET",
    path: "/goals",
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const goalsHtmlPath = path.resolve(frontendDist, "index.html");
      if (fs.existsSync(goalsHtmlPath)) {
        const htmlContent = fs.readFileSync(goalsHtmlPath, "utf-8");
        res.setHeader("Content-Type", "text/html");
        res.send(htmlContent);
      } else {
        res.status(404).send("Goals HTML file not found");
      }
    },
  },
  {
    type: "GET",
    path: "/assets/*",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      _runtime: IAgentRuntime
    ): Promise<void> => {
      const assetRelativePath = req.params?.["0"];
      if (!assetRelativePath) {
        res.status(400).send("Invalid asset path");
        return;
      }
      const filePath = path.resolve(assetsPath, assetRelativePath);

      if (!filePath.startsWith(assetsPath)) {
        res.status(403).send("Forbidden");
        return;
      }

      if (fs.existsSync(filePath)) {
        const sendFile = res.sendFile;
        if (sendFile) {
          sendFile.call(res, filePath);
        } else {
          const content = fs.readFileSync(filePath);
          (res as unknown as { send: (data: Buffer) => void }).send(content);
        }
      } else {
        res.status(404).send("Asset not found");
      }
    },
  },
  {
    type: "GET",
    path: "/api/tags",
    handler: async (_req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        logger.debug("[API /api/tags] Fetching all distinct tags");
        const db = runtime.db as { execute?: (query: unknown) => Promise<unknown> } | undefined;
        if (!db || typeof db.execute !== "function") {
          logger.error("[API /api/tags] runtime.db is not available or not a Drizzle instance.");
          res.status(500).json({ error: "Database not available" });
          return;
        }

        let dbType: "sqlite" | "postgres" | "unknown" = "unknown";
        try {
          const connection = await runtime.getConnection();
          if (connection && connection.constructor.name === "Pool") {
            dbType = "postgres";
          } else {
            try {
              await db.execute(sql`SELECT sqlite_version()`);
              dbType = "sqlite";
            } catch {
              // Not SQLite
            }
          }
        } catch (error) {
          logger.warn("Could not determine database type:", error);
        }

        let result: TagRow[] | DbQueryResult;

        if (dbType === "postgres") {
          const query = sql`SELECT DISTINCT unnest(tags) as tag FROM goal_tags WHERE tag IS NOT NULL;`;
          result = (await db.execute(query)) as TagRow[] | DbQueryResult;
        } else {
          const query = sql`
            SELECT DISTINCT tag 
            FROM goal_tags 
            WHERE tag IS NOT NULL
          `;
          result = (await db.execute(query)) as TagRow[] | DbQueryResult;
        }

        const tags = Array.isArray(result)
          ? result.map((row: TagRow) => row.tag)
          : (result as DbQueryResult).rows
            ? (result as DbQueryResult).rows?.map((row: TagRow) => row.tag)
            : [];

        logger.debug(`[API /api/tags] Found ${tags.length} distinct tags`);
        res.json(tags);
      } catch (error) {
        logger.error("[API /api/tags] Error fetching tags:", error);
        res.status(500).json({ error: "Failed to fetch tags" });
      }
    },
  },
  {
    type: "GET",
    path: "/api/goals",
    handler: async (
      _req: RouteRequest,
      _res: RouteResponse,
      _runtime: IAgentRuntime
    ): Promise<void> => {
      // ... existing code ...
    },
  },
  // API route to create a new goal
  {
    type: "POST",
    path: "/api/goals",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const body = req.body ?? {};
        const name = body.name as string | undefined;
        const description = body.description as string | undefined;
        const tags = body.tags as string[] | undefined;

        if (!name || typeof name !== "string") {
          res.status(400).send("Missing or invalid name");
          return;
        }

        const dataService = createGoalDataService(runtime);

        const newGoalId = await dataService.createGoal({
          agentId: runtime.agentId,
          ownerType: "agent",
          ownerId: runtime.agentId,
          name: String(name),
          description: description ? String(description) : name,
          metadata: {},
          tags: Array.isArray(tags) ? tags.map((t) => String(t)) : ["GOAL"],
        });

        const newGoal = newGoalId ? await dataService.getGoal(newGoalId) : null;
        (res.status(201) as { json: (data: unknown) => void }).json(newGoal);
      } catch (error) {
        console.error("Error creating goal:", error);
        res.status(500).send("Error creating goal");
      }
    },
  },
  {
    type: "PUT",
    path: "/api/goals/:id/complete",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const goalIdStr = req.params.id;

        if (!goalIdStr) {
          res.status(400).send("Missing goalId");
          return;
        }

        const goalId = stringToUuid(goalIdStr) as UUID;
        const dataService = createGoalDataService(runtime);
        const goal = await dataService.getGoal(goalId);

        if (!goal) {
          res.status(404).send("Goal not found");
          return;
        }

        // Check if already completed
        if (goal.isCompleted) {
          res.status(400).send("Goal already completed");
          return;
        }

        const now = new Date();
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
        (res as { json: (data: unknown) => void }).json({
          message: `Goal ${goalId} completed.`,
          goal: updatedGoal,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error completing goal ${req.params.id}:`, error);
        logger.error(`Error completing goal ${req.params.id}:`, error);
        res.status(500).send(`Error completing goal: ${errorMessage}`);
      }
    },
  },
  {
    type: "PUT",
    path: "/api/goals/:id/uncomplete",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const goalIdStr = req.params.id;
        if (!goalIdStr) {
          res.status(400).send("Missing goalId");
          return;
        }

        const goalId = stringToUuid(goalIdStr) as UUID;
        const dataService = createGoalDataService(runtime);
        const goal = await dataService.getGoal(goalId);

        if (!goal) {
          res.status(404).send("Goal not found");
          return;
        }

        // Check if already incomplete
        if (!goal.isCompleted) {
          res.status(400).send("Goal is already not completed");
          return;
        }

        const metadataUpdate = { ...goal.metadata } as Record<string, unknown>;
        delete metadataUpdate.completedAt;

        await dataService.updateGoal(goalId, {
          isCompleted: false,
          completedAt: undefined,
          metadata: metadataUpdate,
        });

        const updatedGoal = await dataService.getGoal(goalId);
        (res as { json: (data: unknown) => void }).json({
          message: `Goal ${goalId} marked as not completed.`,
          goal: updatedGoal,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error uncompleting goal ${req.params.id}:`, error);
        logger.error(`Error uncompleting goal ${req.params.id}:`, error);
        res.status(500).send(`Error uncompleting goal: ${errorMessage}`);
      }
    },
  },
  // API route to update an existing goal
  {
    type: "PUT",
    path: "/api/goals/:id",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const goalIdStr = req.params.id;
        const updateData = req.body as Record<string, unknown>;

        if (!goalIdStr) {
          res.status(400).send("Missing goal ID");
          return;
        }
        if (!updateData || Object.keys(updateData).length === 0) {
          res.status(400).send("Missing update data");
          return undefined;
        }

        const goalId = stringToUuid(goalIdStr) as UUID;
        const dataService = createGoalDataService(runtime);
        const goal = await dataService.getGoal(goalId);

        if (!goal) {
          res.status(404).send("Goal not found");
          return;
        }

        const updates: Record<string, unknown> = {};
        if (updateData.name) updates.name = updateData.name;
        if (updateData.description !== undefined) updates.description = updateData.description;
        if (updateData.tags) updates.tags = updateData.tags;
        if (updateData.metadata)
          updates.metadata = {
            ...goal.metadata,
            ...(updateData.metadata as Record<string, unknown>),
          };

        await dataService.updateGoal(goalId, updates);

        const updatedGoal = await dataService.getGoal(goalId);
        (res as { json: (data: unknown) => void }).json({
          message: `Goal ${goalId} updated successfully.`,
          goal: updatedGoal,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error updating goal ${req.params.id}:`, error);
        logger.error(`Error updating goal ${req.params.id}:`, error);
        res.status(500).send(`Error updating goal: ${errorMessage}`);
      }
    },
  },
  {
    type: "DELETE",
    path: "/api/goals/:id",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const goalIdStr = req.params.id;
        if (!goalIdStr) {
          res.status(400).send("Missing goal ID");
          return;
        }

        const goalId = stringToUuid(goalIdStr) as UUID;
        const dataService = createGoalDataService(runtime);
        const goal = await dataService.getGoal(goalId);

        if (!goal) {
          res.status(404).send("Goal not found");
          return;
        }

        await dataService.deleteGoal(goalId);

        res.json({
          message: `Goal ${goalId} deleted successfully.`,
        });
      } catch (error) {
        console.error(`Error deleting goal ${req.params.id}:`, error);
        logger.error(`Error deleting goal ${req.params.id}:`, error);
        res.status(500).send("Error deleting goal");
      }
    },
  },
];

export default routes;
