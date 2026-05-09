import type { RouteRequestContext } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  LifeOpsOccurrence,
  LifeOpsTaskDefinition,
} from "../contracts/index.js";
import {
  getSelfControlStatus,
  isWebsiteBlockedByPolicy,
  parseSelfControlBlockRequest,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "../website-blocker/engine.js";
import { syncWebsiteBlockerExpiryTask } from "../website-blocker/service.js";

type WebsiteBlockerRequestBody = {
  websites?: string[] | string;
  durationMinutes?: number | string | null;
};

export interface WebsiteBlockerRouteContext extends RouteRequestContext {
  runtime?: IAgentRuntime | null;
}

function buildBlockRequest(
  body: WebsiteBlockerRequestBody,
): ReturnType<typeof parseSelfControlBlockRequest> {
  const parameters: {
    websites?: string[] | string;
    durationMinutes?: number | string | null;
  } = {};

  if (body.websites !== undefined) {
    parameters.websites = body.websites;
  }
  if (body.durationMinutes !== undefined) {
    parameters.durationMinutes = body.durationMinutes;
  }

  return parseSelfControlBlockRequest({
    parameters,
  });
}

interface RequiredTaskInfo {
  id?: string;
  title: string;
  completed: boolean;
}

interface WebsiteBlockerHostResponse {
  blocked: boolean;
  host: string;
  groupKey: string | null;
  requiredTasks: RequiredTaskInfo[];
  websites: string[];
}

async function resolveRequiredTasksForHost(
  runtime: IAgentRuntime,
  host: string,
): Promise<{ groupKey: string | null; requiredTasks: RequiredTaskInfo[] }> {
  const { LifeOpsRepository } = await import("../lifeops/repository.js");
  const repo = new LifeOpsRepository(runtime);

  const agentId = String(runtime.agentId);
  const definitions: LifeOpsTaskDefinition[] =
    await repo.listActiveDefinitions(agentId);

  const matchingDefinitions = definitions.filter((definition) =>
    definition.websiteAccess?.websites.some(
      (website) => website.toLowerCase() === host,
    ),
  );

  if (matchingDefinitions.length === 0) {
    return { groupKey: null, requiredTasks: [] };
  }

  const firstMatchingDefinition = matchingDefinitions[0];
  const groupKey = firstMatchingDefinition.websiteAccess?.groupKey ?? null;
  const requiredTasks: RequiredTaskInfo[] = [];

  for (const definition of matchingDefinitions) {
    const occurrences: LifeOpsOccurrence[] =
      await repo.listOccurrencesForDefinition(agentId, definition.id);

    const currentOccurrence = occurrences
      .filter(
        (occurrence) =>
          occurrence.state !== "expired" && occurrence.state !== "muted",
      )
      .sort((left, right) => {
        const leftTime = Date.parse(left.relevanceStartAt);
        const rightTime = Date.parse(right.relevanceStartAt);
        return rightTime - leftTime;
      })[0];

    const task: RequiredTaskInfo = {
      title: definition.title,
      completed: currentOccurrence?.state === "completed",
    };
    if (currentOccurrence) {
      task.id = currentOccurrence.id;
    }
    requiredTasks.push(task);
  }

  return { groupKey, requiredTasks };
}

export async function handleWebsiteBlockerRoutes(
  ctx: WebsiteBlockerRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, readJsonBody, json, error, runtime } =
    ctx;

  if (
    pathname !== "/api/website-blocker" &&
    pathname !== "/api/website-blocker/status"
  ) {
    return false;
  }

  if (method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const queriedHost = url.searchParams.get("host")?.trim().toLowerCase();

    if (!queriedHost) {
      json(res, await getSelfControlStatus());
      return true;
    }

    const status = await getSelfControlStatus();
    const hostBlocked =
      status.active &&
      isWebsiteBlockedByPolicy(
        {
          blockedWebsites: status.blockedWebsites,
          allowedWebsites: status.allowedWebsites,
          matchMode: status.matchMode,
        },
        queriedHost,
      );

    const result: WebsiteBlockerHostResponse = {
      blocked: hostBlocked,
      host: queriedHost,
      groupKey: null,
      requiredTasks: [],
      websites: status.active ? status.blockedWebsites : [],
    };

    if (hostBlocked && runtime) {
      try {
        const tasks = await resolveRequiredTasksForHost(runtime, queriedHost);
        result.requiredTasks = tasks.requiredTasks;
        result.groupKey = tasks.groupKey;
      } catch (err) {
        logger.error(
          {
            host: queriedHost,
            error: err instanceof Error ? err.message : String(err),
          },
          "[WebsiteBlockerRoutes] Failed to resolve required tasks for host",
        );
        error(
          res,
          `Failed to resolve required tasks for blocked host: ${
            err instanceof Error ? err.message : String(err)
          }`,
          500,
        );
        return true;
      }
    }

    json(res, result);
    return true;
  }

  if (method === "POST" || method === "PUT") {
    const body = await readJsonBody<WebsiteBlockerRequestBody>(req, res);
    if (!body) return true;

    const parsed = buildBlockRequest(body);
    if (!parsed.request) {
      json(
        res,
        {
          success: false,
          error:
            parsed.error ?? "Could not parse the website block request body.",
        },
        400,
      );
      return true;
    }

    if (parsed.request.durationMinutes !== null && !runtime) {
      error(
        res,
        "Timed website blocks require the Eliza runtime so Eliza can schedule the automatic unblock task.",
        503,
      );
      return true;
    }

    const result = await startSelfControlBlock({
      ...parsed.request,
      scheduledByAgentId: runtime ? String(runtime.agentId) : null,
    });
    if (result.success === true) {
      if (parsed.request.durationMinutes !== null && runtime) {
        try {
          const taskId = await syncWebsiteBlockerExpiryTask(runtime);
          if (!taskId) {
            await stopSelfControlBlock();
            json(
              res,
              {
                success: false,
                error:
                  "Eliza started the website block but could not schedule its automatic unblock task, so it rolled the block back.",
              },
              500,
            );
            return true;
          }
        } catch (scheduleError) {
          await stopSelfControlBlock();
          json(
            res,
            {
              success: false,
              error: `Eliza could not schedule the automatic unblock task, so it rolled the website block back. ${scheduleError instanceof Error ? scheduleError.message : String(scheduleError)}`,
            },
            500,
          );
          return true;
        }
      }

      json(
        res,
        {
          success: true,
          endsAt: result.endsAt,
          request: parsed.request,
        },
        200,
      );
    } else {
      json(
        res,
        {
          success: false,
          error: result.error,
          status: result.status,
        },
        409,
      );
    }
    return true;
  }

  if (method === "DELETE") {
    const result = await stopSelfControlBlock();
    if (result.success === true) {
      json(
        res,
        {
          success: true,
          removed: result.removed,
          status: result.status,
        },
        200,
      );
    } else {
      json(
        res,
        {
          success: false,
          error: result.error,
          status: result.status,
        },
        409,
      );
    }
    return true;
  }

  return false;
}
