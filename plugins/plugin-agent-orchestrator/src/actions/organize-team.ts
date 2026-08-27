/** Exposes durable autonomous organization kickoff and reconciliation to the runtime planner. */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  AUTONOMOUS_ORGANIZATION_SERVICE_TYPE,
  type AutonomousOrganizationService,
  autonomousOrganizationsEnabled,
} from "../services/autonomous-organization-service.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectiveFrom(
  message: Memory,
  options?: HandlerOptions,
): string | undefined {
  const params = record(options?.parameters);
  const content = record(message.content);
  const candidate = params.objective ?? content.objective ?? content.text;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

export const organizeTeamAction: Action = {
  name: "ORGANIZE_TEAM",
  description:
    "Create a durable autonomous agent organization from one objective. The coordinator selects available workers, delegates dependency-aware work, and resumes unfinished work after restart.",
  descriptionCompressed:
    "durable autonomous agent team from one objective; select workers, delegate, persist, resume",
  similes: [
    "ASSEMBLE_AGENT_TEAM",
    "CREATE_AGENT_ORGANIZATION",
    "DELEGATE_TO_TEAM",
    "RUN_AUTONOMOUS_TEAM",
  ],
  tags: [
    "domain:agent-orchestration",
    "resource:agent-organization",
    "capability:delegate",
    "capability:execute",
    "effect:idempotent",
  ],
  parameters: [
    {
      name: "objective",
      description:
        "The complete outcome the autonomous team should pursue. Preserve all requirements and constraints.",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
  ],
  validate: async (runtime) =>
    autonomousOrganizationsEnabled(runtime) &&
    Boolean(runtime.getService(AUTONOMOUS_ORGANIZATION_SERVICE_TYPE)),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const objective = objectiveFrom(message, options);
    if (!autonomousOrganizationsEnabled(runtime)) {
      return {
        success: false,
        text: "Autonomous organization execution is not enabled by this host.",
        error: "ORGANIZATION_EXECUTION_NOT_AUTHORIZED",
      };
    }
    if (!objective) {
      return {
        success: false,
        text: "An organization objective is required.",
        error: "ORGANIZATION_OBJECTIVE_REQUIRED",
      };
    }
    if (!message.entityId || !message.id) {
      return {
        success: false,
        text: "The organization request or sponsor identity is unavailable.",
        error: "ORGANIZATION_REQUEST_IDENTITY_REQUIRED",
      };
    }
    const service = runtime.getService<AutonomousOrganizationService>(
      AUTONOMOUS_ORGANIZATION_SERVICE_TYPE,
    );
    if (!service) {
      return {
        success: false,
        text: "Autonomous organization service is unavailable.",
        error: "ORGANIZATION_SERVICE_UNAVAILABLE",
      };
    }
    const organization = await service.startOrganization({
      requestId: message.id,
      sponsorPrincipalId: message.entityId,
      objective,
    });
    const active = organization.organization.workItems.filter(
      (item) => item.status === "in_progress",
    );
    const text = `Organization ${organization.organization.name} is ${organization.organization.status} with ${organization.organization.members.length - 1} selected worker(s); ${active.length} work item(s) are running.`;
    if (callback) {
      await callback({
        text,
        actions: ["ORGANIZE_TEAM"],
        data: {
          organizationId: organization.organization.id,
          revision: organization.revision,
          status: organization.organization.status,
        },
      });
    }
    return {
      success: true,
      text,
      data: {
        organizationId: organization.organization.id,
        revision: organization.revision,
        status: organization.organization.status,
        members: organization.organization.members,
        workItems: organization.organization.workItems,
      },
    };
  },
};
