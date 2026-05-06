import type {
  Route,
  RouteRequest,
  RouteResponse,
  IAgentRuntime,
} from "@elizaos/core";
import {
  validateWorkflow,
  validateNodeParameters,
  validateNodeInputs,
  positionNodes,
} from "../utils/workflow";
import type { N8nWorkflow } from "../types/index";
import { getService } from "./_helpers";

/**
 * GET /workflows
 */
async function listWorkflows(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  try {
    const userId = req.query?.userId as string | undefined;
    const service = getService(runtime);
    const workflows = await service.listWorkflows(userId);
    res.json({ success: true, data: workflows });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "failed_to_list_workflows",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * POST /workflows
 * Body: { workflow: N8nWorkflow, userId: string, activate?: boolean }
 */
async function createWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  try {
    const { workflow, userId, activate } = req.body as unknown as {
      workflow: N8nWorkflow;
      userId: string;
      activate?: boolean;
    };

    if (!workflow || !userId) {
      res
        .status(400)
        .json({ success: false, error: "workflow and userId are required" });
      return;
    }

    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      res.status(422).json({
        success: false,
        error: "validation_failed",
        errors: validation.errors,
        warnings: validation.warnings,
      });
      return;
    }

    const paramWarnings = validateNodeParameters(workflow);
    const inputWarnings = validateNodeInputs(workflow);
    const positioned = positionNodes(workflow);

    const service = getService(runtime);
    const result = await service.deployWorkflow(positioned, userId);

    if (result.missingCredentials.length > 0 && !result.id) {
      res.status(200).json({
        success: false,
        reason: "missing_integrations",
        missingIntegrations: result.missingCredentials,
        warnings: [...paramWarnings, ...inputWarnings],
      });
      return;
    }

    if (activate === false && result.active && result.id) {
      await service.deactivateWorkflow(result.id);
      result.active = false;
    }

    res.json({
      success: true,
      data: result,
      warnings: [...paramWarnings, ...inputWarnings],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "failed_to_create_workflow",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * GET /workflows/:id
 */
async function getWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: "workflow_id_required" });
      return;
    }

    const service = getService(runtime);
    const workflow = await service.getWorkflow(id);
    res.json({ success: true, data: workflow });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "failed_to_get_workflow",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * PUT /workflows/:id
 * Body: { workflow: N8nWorkflow, userId: string }
 *
 * Uses deployWorkflow which handles credential resolution + update (when id is set).
 */
async function updateWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: "workflow_id_required" });
      return;
    }

    const { workflow, userId } = req.body as unknown as {
      workflow: N8nWorkflow;
      userId: string;
    };

    if (!workflow || !userId) {
      res
        .status(400)
        .json({ success: false, error: "workflow and userId are required" });
      return;
    }

    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      res.status(422).json({
        success: false,
        error: "validation_failed",
        errors: validation.errors,
        warnings: validation.warnings,
      });
      return;
    }

    const paramWarnings = validateNodeParameters(workflow);
    const inputWarnings = validateNodeInputs(workflow);
    const positioned = positionNodes({ ...workflow, id });

    const service = getService(runtime);
    const result = await service.deployWorkflow(positioned, userId);

    if (result.missingCredentials.length > 0 && !result.id) {
      res.status(200).json({
        success: false,
        reason: "missing_integrations",
        missingIntegrations: result.missingCredentials,
        warnings: [...paramWarnings, ...inputWarnings],
      });
      return;
    }

    res.json({
      success: true,
      data: result,
      warnings: [...paramWarnings, ...inputWarnings],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "failed_to_update_workflow",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * DELETE /workflows/:id
 */
async function deleteWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: "workflow_id_required" });
      return;
    }

    const service = getService(runtime);
    await service.deleteWorkflow(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "failed_to_delete_workflow",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * POST /workflows/:id/activate
 */
async function activateWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: "workflow_id_required" });
      return;
    }

    const service = getService(runtime);
    await service.activateWorkflow(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "failed_to_activate_workflow",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * POST /workflows/:id/deactivate
 */
async function deactivateWorkflow(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  try {
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ success: false, error: "workflow_id_required" });
      return;
    }

    const service = getService(runtime);
    await service.deactivateWorkflow(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "failed_to_deactivate_workflow",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export const workflowRoutes: Route[] = [
  { type: "GET", path: "/workflows", handler: listWorkflows },
  { type: "POST", path: "/workflows", handler: createWorkflow },
  { type: "GET", path: "/workflows/:id", handler: getWorkflow },
  { type: "PUT", path: "/workflows/:id", handler: updateWorkflow },
  { type: "DELETE", path: "/workflows/:id", handler: deleteWorkflow },
  { type: "POST", path: "/workflows/:id/activate", handler: activateWorkflow },
  {
    type: "POST",
    path: "/workflows/:id/deactivate",
    handler: deactivateWorkflow,
  },
];
