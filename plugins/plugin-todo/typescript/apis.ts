import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChannelType,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Room,
  type Route,
  type RouteRequest,
  type RouteResponse,
  type UUID,
  type World,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { createTodoDataService } from "./services/todoDataService";

// Define the equivalent of __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the path to the frontend distribution directory, assuming it's in 'dist'
// relative to the package root (which is two levels up from src/plugin-todo)
const frontendDist = path.resolve(__dirname, "../dist");

const frontPagePath = path.resolve(frontendDist, "index.html");
const assetsPath = path.resolve(frontendDist, "assets");
console.log("*** frontPagePath", frontPagePath);
console.log("*** assetsPath", assetsPath);
/**
 * Definition of routes with type, path, and handler for each route.
 * Routes include fetching trending tokens, wallet information, posts, sentiment analysis, and signals.
 */

export const routes: Route[] = [
  {
    type: "GET",
    path: "/",
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const indexPath = path.resolve(frontendDist, "index.html");
      if (fs.existsSync(indexPath)) {
        const htmlContent = fs.readFileSync(indexPath, "utf-8");
        // Set Content-Type header to text/html
        res.setHeader?.("Content-Type", "text/html");
        res.send(htmlContent);
      } else {
        res.status(404).send("HTML file not found");
      }
    },
  },
  {
    type: "GET",
    path: "/todos",
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      const todosHtmlPath = path.resolve(frontendDist, "index.html");
      if (fs.existsSync(todosHtmlPath)) {
        const htmlContent = fs.readFileSync(todosHtmlPath, "utf-8");
        // Set Content-Type header to text/html
        res.setHeader?.("Content-Type", "text/html");
        res.send(htmlContent);
      } else {
        res.status(404).send("Todos HTML file not found");
      }
    },
  },
  // Route to serve JS files from frontendDist/assets
  {
    type: "GET",
    path: "/assets/*",
    handler: async (
      req: RouteRequest,
      res: RouteResponse,
      _runtime: IAgentRuntime
    ): Promise<void> => {
      // Extract the relative path after '/assets/'
      const assetRelativePath = req.params?.["0"]; // This captures everything after '/assets/'
      if (!assetRelativePath) {
        res.status(400).send("Invalid asset path");
        return;
      }
      // Construct the full path to the asset within the frontendDist/assets directory
      const filePath = path.resolve(assetsPath, assetRelativePath); // Corrected base path

      // Basic security check to prevent path traversal
      if (!filePath.startsWith(assetsPath)) {
        res.status(403).send("Forbidden");
        return;
      }

      // Check if the file exists and serve it
      if (fs.existsSync(filePath)) {
        // Let express handle MIME types based on file extension
        res.sendFile?.(filePath);
      } else {
        res.status(404).send("Asset not found");
      }
    },
  },
  // API route to get all TODOs, structured by world and room
  {
    type: "GET",
    path: "/api/todos",
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ): Promise<void> => {
      try {
        const dataService = createTodoDataService(runtime);

        // 1. Get all room IDs the agent is a participant in
        const agentRoomIds = await runtime.getRoomsForParticipant(runtime.agentId);
        if (!agentRoomIds || agentRoomIds.length === 0) {
          logger.debug(
            `[API /api/todos] Agent ${runtime.agentId} is not a participant in any rooms.`
          );
          res.json([]); // No rooms for this agent
          return;
        }
        logger.debug(
          `[API /api/todos] Agent ${runtime.agentId} is in rooms: ${agentRoomIds.join(", ")}`
        );

        // 2. Fetch details for these specific rooms
        const agentRooms: Room[] = [];
        // Fetch rooms in batches if needed, but likely fine for typical numbers
        for (const roomId of agentRoomIds) {
          const room = await runtime.getRoom(roomId);
          if (room) {
            agentRooms.push(room);
          } else {
            logger.warn(`[API /api/todos] Could not fetch details for room ID: ${roomId}`);
          }
        }
        if (agentRooms.length === 0) {
          logger.debug(
            `[API /api/todos] No valid room details found for agent's participated rooms.`
          );
          res.json([]);
          return;
        }

        // 3. Fetch all TODO tasks for these specific rooms using the data service
        const tasksByRoom = new Map<string, unknown[]>();

        // Fetch tasks per room
        for (const roomId of agentRoomIds) {
          const todos = await dataService.getTodos({ roomId });
          tasksByRoom.set(roomId, todos || []);
        }

        // 4. Group rooms by World ID and fetch World details
        const roomsByWorld = new Map<string, Room[]>();
        const worldIds = new Set<UUID>();
        for (const room of agentRooms) {
          const worldId = room.worldId;
          if (worldId) {
            worldIds.add(worldId);
            if (!roomsByWorld.has(worldId)) {
              roomsByWorld.set(worldId, []);
            }
            roomsByWorld.get(worldId)?.push(room);
          } else {
            logger.warn(`[API /api/todos] Room ${room.id} is missing worldId.`);
            // Handle rooms without worldId (e.g., add to a default/unknown world)
            const unknownWorldId = "unknown-world";
            if (!roomsByWorld.has(unknownWorldId)) roomsByWorld.set(unknownWorldId, []);
            roomsByWorld.get(unknownWorldId)?.push(room);
          }
        }

        const worldsMap = new Map<string, World>();
        for (const worldId of worldIds) {
          const world = await runtime.getWorld(worldId);
          if (world) worldsMap.set(worldId, world);
        }
        // Add placeholder for unknown world if needed
        if (roomsByWorld.has("unknown-world")) {
          worldsMap.set("unknown-world", {
            id: "unknown-world" as UUID,
            name: "Rooms without World",
          } as World);
        }

        // 5. Structure the final response
        const structuredResponse = Array.from(worldsMap.entries()).map(([worldId, world]) => {
          const rooms = roomsByWorld.get(worldId) || [];
          return {
            worldId: world.id,
            worldName: world.name || `World ${world.id.substring(0, 6)}`,
            rooms: rooms.map((room) => ({
              roomId: room.id,
              roomName: room.name || `Room ${room.id.substring(0, 6)}`,
              tasks: tasksByRoom.get(room.id) || [],
            })),
          };
        });

        res.json(structuredResponse);
      } catch (error) {
        console.error("Error fetching structured todos:", error);
        logger.error(
          "[API /api/todos] Error fetching structured todos:",
          error instanceof Error ? error.message : String(error)
        );
        res.status(500).send("Error fetching todos");
      }
    },
  },
  // API route to get all tags
  {
    type: "GET",
    path: "/api/tags",
    handler: async (
      _req: RouteRequest,
      res: RouteResponse,
      runtime: IAgentRuntime
    ): Promise<void> => {
      try {
        logger.debug("[API /api/tags] Fetching all distinct tags");

        // Use runtime.db which should be the Drizzle instance from the adapter
        const db = runtime.db as { execute: (query: unknown) => Promise<unknown> };
        if (!db || typeof db.execute !== "function") {
          logger.error("[API /api/tags] runtime.db is not available or not a Drizzle instance.");
          res.status(500).json({ error: "Database not available" });
          return;
        }

        // Detect database type
        let dbType: "sqlite" | "postgres" | "unknown" = "unknown";
        try {
          // Try PostgreSQL detection
          const connection = await runtime.getConnection();
          if (connection && connection.constructor.name === "Pool") {
            dbType = "postgres";
          } else {
            // Try SQLite detection
            try {
              await db.execute(sql`SELECT sqlite_version()`);
              dbType = "sqlite";
            } catch {
              // Not SQLite
            }
          }
        } catch (error) {
          logger.warn(
            "Could not determine database type:",
            error instanceof Error ? error.message : String(error)
          );
        }

        let result: unknown;

        if (dbType === "postgres") {
          // PostgreSQL query using unnest
          const query = sql`SELECT DISTINCT unnest(tags) as tag FROM todo_tags WHERE tag IS NOT NULL;`;
          result = await db.execute(query);
        } else {
          // SQLite-compatible query
          const query = sql`
            SELECT DISTINCT tag 
            FROM todo_tags 
            WHERE tag IS NOT NULL
          `;
          result = await db.execute(query);
        }

        // Drizzle's execute might return results differently depending on the driver
        // Adapting for common patterns (e.g., pg driver returning 'rows')
        const tags = Array.isArray(result)
          ? result.map((row: { tag?: string }) => row.tag)
          : (result as { rows?: Array<{ tag?: string }> }).rows
            ? (result as { rows: Array<{ tag?: string }> }).rows.map((row) => row.tag)
            : [];

        logger.debug(`[API /api/tags] Found ${tags.length} distinct tags`);
        res.json(tags);
      } catch (error) {
        logger.error(
          "[API /api/tags] Error fetching tags:",
          error instanceof Error ? error.message : String(error)
        );
        res.status(500).json({ error: "Failed to fetch tags" });
      }
    },
  },
  // API route to create a new TODO
  {
    type: "POST",
    path: "/api/todos",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const body = req.body || {};
        const name = String(body.name || "");
        const type = String(body.type || "");
        const priority =
          typeof body.priority === "number"
            ? body.priority
            : typeof body.priority === "string"
              ? parseInt(body.priority, 10)
              : undefined;
        const dueDate = typeof body.dueDate === "string" ? body.dueDate : undefined;
        const isUrgent =
          typeof body.isUrgent === "boolean"
            ? body.isUrgent
            : String(body.isUrgent || "") === "true";
        const roomId = String(body.roomId || "");

        if (!name || !type || !roomId) {
          res.status(400).send("Missing required fields: name, type, roomId");
          return;
        }

        const dataService = createTodoDataService(runtime);
        const tags = ["TODO"];
        const metadata: Record<string, unknown> = {};

        // --- Determine Task Type and Tags ---
        if (type === "daily") {
          tags.push("daily", "recurring-daily");
          metadata.completedToday = false;
        } else if (type === "one-off") {
          tags.push("one-off");
          if (dueDate) {
            // Validate date format if necessary
            try {
              new Date(dueDate);
            } catch (_e) {
              res.status(400).send("Invalid due date format");
              return;
            }
          }
          if (priority !== undefined && priority >= 1 && priority <= 4) {
            tags.push(`priority-${priority}`);
          } else {
            tags.push("priority-4"); // Default priority
          }
          if (isUrgent) {
            tags.push("urgent");
          }
        } else if (type === "aspirational") {
          tags.push("aspirational");
          // No specific metadata needed initially
        } else {
          res.status(400).send("Invalid task type");
          return;
        }

        const worldId = createUniqueUuid(runtime, runtime.agentId);

        await runtime.ensureConnection({
          entityId: runtime.agentId,
          roomId: roomId as UUID,
          worldId: worldId,
          type: ChannelType.GROUP,
          name: name.trim(),
          source: "the-system",
          worldName: "The System",
        });

        const newTodoId = await dataService.createTodo({
          agentId: runtime.agentId,
          worldId: worldId as UUID,
          roomId: roomId as UUID,
          entityId: runtime.agentId,
          name,
          description: `User added TODO: ${name}`, // Simple description
          type: type as "daily" | "one-off" | "aspirational",
          priority: type === "one-off" ? priority || 4 : undefined,
          isUrgent: type === "one-off" ? isUrgent || false : false,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          metadata,
          tags,
        });

        const newTodo = await dataService.getTodo(newTodoId);
        res.status(201).json(newTodo);
      } catch (error) {
        console.error("Error creating todo:", error);
        res.status(500).send("Error creating todo");
      }
    },
  },
  // API route to complete a TODO
  {
    type: "PUT",
    path: "/api/todos/:id/complete",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const taskId = req.params?.id;

        // Task ID is required
        if (!taskId) {
          res.status(400).send("Missing taskId");
          return;
        }

        const dataService = createTodoDataService(runtime);
        const task = await dataService.getTodo(taskId as UUID);

        if (!task) {
          res.status(404).send("Task not found");
          return;
        }

        // Check if already completed
        if (task.isCompleted) {
          res.status(400).send("Task already completed");
          return;
        }

        const now = new Date();
        const metadataUpdate: Record<string, unknown> = {
          ...task.metadata,
          completedAt: now.toISOString(),
        };

        // Handle daily task metadata
        if (task.type === "daily") {
          metadataUpdate.completedToday = true;
          metadataUpdate.lastCompletedDate = now.toISOString().split("T")[0];
        }

        // Update the task
        await dataService.updateTodo(taskId as UUID, {
          isCompleted: true,
          completedAt: now,
          metadata: metadataUpdate,
        });

        // Return the final task state
        const updatedTask = await dataService.getTodo(taskId as UUID);
        res.json({
          message: `Task ${taskId} completed.`,
          task: updatedTask,
        });
      } catch (error: unknown) {
        console.error(`Error completing todo ${req.params?.id}:`, error);
        res.status(500).send("Error completing todo");
      }
    },
  },
  // API route to uncomplete a TODO
  {
    type: "PUT",
    path: "/api/todos/:id/uncomplete",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const taskId = req.params?.id;
        if (!taskId) {
          res.status(400).send("Missing taskId");
          return;
        }

        const dataService = createTodoDataService(runtime);
        const task = await dataService.getTodo(taskId as UUID);

        if (!task) {
          res.status(404).send("Task not found");
          return;
        }

        // Check if already incomplete
        if (!task.isCompleted) {
          res.status(400).send("Task is already not completed");
          return;
        }

        // --- Logic to reverse completion ---
        const metadataUpdate = { ...task.metadata };
        delete metadataUpdate.completedAt;
        // Optionally handle daily task metadata
        if (task.type === "daily" && metadataUpdate.completedToday) {
          delete metadataUpdate.completedToday;
        }

        await dataService.updateTodo(taskId as UUID, {
          isCompleted: false,
          completedAt: undefined,
          metadata: metadataUpdate,
        });

        const updatedTask = await dataService.getTodo(taskId as UUID);
        res.json({
          message: `Task ${taskId} marked as not completed.`,
          task: updatedTask,
        });
      } catch (error: unknown) {
        console.error(`Error uncompleting todo ${req.params?.id}:`, error);
        logger.error(
          `Error uncompleting todo ${req.params?.id}:`,
          error instanceof Error ? error.message : String(error)
        );
        res
          .status(500)
          .send(
            `Error uncompleting todo: ${error instanceof Error ? error.message : String(error)}`
          );
      }
    },
  },
  // API route to update an existing TODO
  {
    type: "PUT",
    path: "/api/todos/:id",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const taskId = req.params?.id;
        const updateData = req.body as TaskUpdate; // Directly use interface from updateTodo.ts

        if (!taskId) {
          res.status(400).send("Missing task ID");
          return;
        }
        if (!updateData || Object.keys(updateData).length === 0) {
          res.status(400).send("Missing update data");
          return;
        }

        const dataService = createTodoDataService(runtime);
        const task = await dataService.getTodo(taskId as UUID);

        if (!task) {
          res.status(404).send("Task not found");
          return;
        }

        // --- Apply updates (similar logic to applyTaskUpdate in updateTodo.ts) ---
        const updatedTags = [...(task.tags || [])];
        const updatedMetadata = { ...(task.metadata || {}) };
        const updatedTaskData: Record<string, unknown> = {};

        if (updateData.name) updatedTaskData.name = updateData.name;
        if (updateData.description !== undefined)
          updatedTaskData.description = updateData.description;

        // Update priority (for one-off tasks)
        if (updateData.priority && task.type === "one-off") {
          updatedTaskData.priority = updateData.priority;
          // Update priority tag
          const priorityIndex = updatedTags.findIndex((tag) => tag.startsWith("priority-"));
          if (priorityIndex !== -1) {
            updatedTags.splice(priorityIndex, 1);
          }
          updatedTags.push(`priority-${updateData.priority}`);
        }

        // Update urgency (for one-off tasks)
        if (updateData.urgent !== undefined && task.type === "one-off") {
          updatedTaskData.isUrgent = updateData.urgent;
          const urgentIndex = updatedTags.indexOf("urgent");
          if (urgentIndex !== -1) {
            updatedTags.splice(urgentIndex, 1);
          }
          if (updateData.urgent) {
            updatedTags.push("urgent");
          }
        }

        // Update recurring pattern (for daily tasks)
        if (updateData.recurring && task.type === "daily") {
          const recurringIndex = updatedTags.findIndex((tag) => tag.startsWith("recurring-"));
          if (recurringIndex !== -1) {
            updatedTags.splice(recurringIndex, 1);
          }
          updatedTags.push(`recurring-${updateData.recurring}`);
          updatedMetadata.recurring = updateData.recurring;
        }

        // Update due date (for one-off tasks)
        if (updateData.dueDate !== undefined) {
          if (updateData.dueDate === null) {
            updatedTaskData.dueDate = null;
          } else {
            updatedTaskData.dueDate = new Date(updateData.dueDate);
          }
        }

        // Apply all updates (tags are handled separately)
        await dataService.updateTodo(taskId as UUID, {
          ...updatedTaskData,
          metadata: updatedMetadata,
        });

        // Update tags separately
        const currentTags = task.tags || [];
        const tagsToAdd = updatedTags.filter((tag) => !currentTags.includes(tag));
        const tagsToRemove = currentTags.filter((tag) => !updatedTags.includes(tag));

        if (tagsToAdd.length > 0) {
          await dataService.addTags(taskId as UUID, tagsToAdd);
        }
        if (tagsToRemove.length > 0) {
          await dataService.removeTags(taskId as UUID, tagsToRemove);
        }

        const updatedTask = await dataService.getTodo(taskId as UUID);
        res.json({
          message: `Task ${taskId} updated successfully.`,
          task: updatedTask,
        });
      } catch (error: unknown) {
        console.error(`Error updating todo ${req.params?.id}:`, error);
        logger.error(
          `Error updating todo ${req.params?.id}:`,
          error instanceof Error ? error.message : String(error)
        );
        res
          .status(500)
          .send(`Error updating todo: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  // API route to delete a TODO
  {
    type: "DELETE",
    path: "/api/todos/:id",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const taskId = req.params?.id;
        if (!taskId) {
          res.status(400).send("Missing task ID");
          return;
        }

        const dataService = createTodoDataService(runtime);
        const task = await dataService.getTodo(taskId as UUID);

        if (!task) {
          res.status(404).send("Task not found");
          return;
        }

        await dataService.deleteTodo(taskId as UUID);

        res.json({
          message: `Task ${taskId} deleted successfully.`,
        });
      } catch (error: unknown) {
        console.error(`Error deleting todo ${req.params?.id}:`, error);
        logger.error(
          `Error deleting todo ${req.params?.id}:`,
          error instanceof Error ? error.message : String(error)
        );
        res.status(500).send("Error deleting todo");
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
  recurring?: "daily" | "weekly" | "monthly";
}
