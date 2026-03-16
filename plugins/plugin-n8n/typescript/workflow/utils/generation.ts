import { type IAgentRuntime, logger, ModelType } from "@elizaos/core";
import {
  ACTION_RESPONSE_SYSTEM_PROMPT,
  DRAFT_INTENT_SYSTEM_PROMPT,
  FEASIBILITY_CHECK_PROMPT,
  KEYWORD_EXTRACTION_SYSTEM_PROMPT,
  WORKFLOW_GENERATION_SYSTEM_PROMPT,
} from "../prompts/index";
import { WORKFLOW_MATCHING_SYSTEM_PROMPT } from "../prompts/workflowMatching";
import {
  draftIntentSchema,
  feasibilitySchema,
  keywordExtractionSchema,
  workflowMatchingSchema,
} from "../schemas/index";
import type {
  DraftIntentResult,
  FeasibilityResult,
  KeywordExtractionResult,
  N8nWorkflow,
  NodeDefinition,
  NodeSearchResult,
  WorkflowDraft,
  WorkflowMatchResult,
} from "../types/index";
import { getNodeDefinition } from "./catalog";

export async function extractKeywords(
  runtime: IAgentRuntime,
  userPrompt: string
): Promise<string[]> {
  let result: KeywordExtractionResult;
  try {
    result = (await runtime.useModel(ModelType.OBJECT_SMALL, {
      prompt: `${KEYWORD_EXTRACTION_SYSTEM_PROMPT}\n\nUser request: ${userPrompt}`,
      schema: keywordExtractionSchema,
    })) as KeywordExtractionResult;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { src: "plugin:n8n:generation:keywords", error: errMsg },
      `Keyword extraction LLM call failed: ${errMsg}`
    );
    throw new Error(`Keyword extraction failed: ${errMsg}`);
  }

  // Validate structure
  if (!result || !result.keywords || !Array.isArray(result.keywords)) {
    logger.error(
      { src: "plugin:n8n:generation:keywords", result: JSON.stringify(result) },
      "Invalid keyword extraction response structure"
    );
    throw new Error("Invalid keyword extraction response: missing or invalid keywords array");
  }

  // Validate all items are strings
  if (!result.keywords.every((kw) => typeof kw === "string")) {
    throw new Error("Keywords array contains non-string elements");
  }

  // Limit to 5 keywords max, filter empty strings
  return result.keywords
    .slice(0, 5)
    .map((kw) => kw.trim())
    .filter((kw) => kw.length > 0);
}

export async function matchWorkflow(
  runtime: IAgentRuntime,
  userRequest: string,
  workflows: N8nWorkflow[]
): Promise<WorkflowMatchResult> {
  if (workflows.length === 0) {
    return {
      matchedWorkflowId: null,
      confidence: "none",
      matches: [],
      reason: "No workflows available",
    };
  }

  try {
    // Build workflow list for LLM
    const workflowList = workflows
      .map(
        (wf, index) =>
          `${index + 1}. "${wf.name}" (ID: ${wf.id}, Status: ${wf.active ? "ACTIVE" : "INACTIVE"})`
      )
      .join("\n");

    const userPrompt = `${userRequest}

Available workflows:
${workflowList}`;

    let result: WorkflowMatchResult;
    try {
      result = (await runtime.useModel(ModelType.OBJECT_SMALL, {
        prompt: `${WORKFLOW_MATCHING_SYSTEM_PROMPT}\n\n${userPrompt}`,
        schema: workflowMatchingSchema,
      })) as WorkflowMatchResult;
    } catch (innerError) {
      const errMsg = innerError instanceof Error ? innerError.message : String(innerError);
      logger.error(
        { src: "plugin:n8n:generation:matcher", error: errMsg },
        `Workflow matching LLM call failed: ${errMsg}`
      );
      throw innerError;
    }

    // Validate the returned ID actually exists in the provided list
    if (result.matchedWorkflowId && !workflows.some((wf) => wf.id === result.matchedWorkflowId)) {
      logger.warn(
        { src: "plugin:n8n:generation:matcher" },
        `LLM returned non-existent workflow ID "${result.matchedWorkflowId}" — discarding`
      );
      result.matchedWorkflowId = null;
      result.confidence = "none";
    }

    logger.debug(
      { src: "plugin:n8n:generation:matcher" },
      `Workflow match: ${result.matchedWorkflowId || "none"} (confidence: ${result.confidence})`
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      { src: "plugin:n8n:generation:matcher" },
      `Workflow matching failed: ${errorMessage}`
    );

    return {
      matchedWorkflowId: null,
      confidence: "none",
      matches: [],
      reason: `Workflow matching service unavailable: ${errorMessage}`,
    };
  }
}

export async function classifyDraftIntent(
  runtime: IAgentRuntime,
  userMessage: string,
  draft: WorkflowDraft
): Promise<DraftIntentResult> {
  const draftSummary = `Workflow: "${draft.workflow.name}"
Nodes: ${draft.workflow.nodes.map((n) => `${n.name} (${n.type})`).join(", ")}
Original prompt: "${draft.prompt}"`;

  let result: DraftIntentResult;
  try {
    result = (await runtime.useModel(ModelType.OBJECT_SMALL, {
      prompt: `${DRAFT_INTENT_SYSTEM_PROMPT}

## Current Draft

${draftSummary}

## User Message

${userMessage}`,
      schema: draftIntentSchema,
    })) as DraftIntentResult;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { src: "plugin:n8n:generation:intent", error: errMsg },
      `classifyDraftIntent LLM call failed: ${errMsg}`
    );
    return {
      intent: "show_preview",
      reason: `Intent classification failed (${errMsg}) — re-showing preview`,
    };
  }

  const validIntents = ["confirm", "cancel", "modify", "new"] as const;
  if (!result?.intent || !validIntents.includes(result.intent as (typeof validIntents)[number])) {
    logger.warn(
      { src: "plugin:n8n:generation:intent" },
      `Invalid intent from LLM: ${JSON.stringify(result)}, re-showing preview`
    );
    return { intent: "show_preview", reason: "Could not classify intent — re-showing preview" };
  }

  logger.debug(
    { src: "plugin:n8n:generation:intent" },
    `Draft intent: ${result.intent} — ${result.reason}`
  );

  return result;
}

function parseWorkflowResponse(response: string): N8nWorkflow {
  const cleaned = response
    .replace(/^\s*```json\s*/i, "")
    .replace(/^\s*```\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let workflow: N8nWorkflow;
  try {
    workflow = JSON.parse(cleaned) as N8nWorkflow;
  } catch (error) {
    throw new Error(
      `Failed to parse workflow JSON: ${error instanceof Error ? error.message : String(error)}\n\nRaw response: ${response}`
    );
  }

  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    throw new Error("Invalid workflow: missing or invalid nodes array");
  }

  if (!workflow.connections || typeof workflow.connections !== "object") {
    throw new Error("Invalid workflow: missing or invalid connections object");
  }

  return workflow;
}

export async function generateWorkflow(
  runtime: IAgentRuntime,
  userPrompt: string,
  relevantNodes: NodeDefinition[]
): Promise<N8nWorkflow> {
  const fullPrompt = `${WORKFLOW_GENERATION_SYSTEM_PROMPT}

## Relevant Nodes Available

${JSON.stringify(relevantNodes, null, 2)}

Use these node definitions to generate the workflow. Each node's "properties" field defines the available parameters.

## User Request

${userPrompt}

Generate a valid n8n workflow JSON that fulfills this request.`;

  const response = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: fullPrompt,
    temperature: 0,
    responseFormat: { type: "json_object" },
  });

  const workflow = parseWorkflowResponse(response);

  if (!workflow.name) {
    workflow.name = `Workflow - ${userPrompt.slice(0, 50).trim()}`;
  }

  return workflow;
}

export async function modifyWorkflow(
  runtime: IAgentRuntime,
  existingWorkflow: N8nWorkflow,
  modificationRequest: string,
  relevantNodes: NodeDefinition[]
): Promise<N8nWorkflow> {
  const { _meta, ...workflowForLLM } = existingWorkflow;

  const fullPrompt = `${WORKFLOW_GENERATION_SYSTEM_PROMPT}

## Relevant Nodes Available

${JSON.stringify(relevantNodes, null, 2)}

Use these node definitions to modify the workflow. Each node's "properties" field defines the available parameters.

## Existing Workflow (modify this)

${JSON.stringify(workflowForLLM, null, 2)}

## Modification Request

${modificationRequest}

Modify the existing workflow according to the request above. Return the COMPLETE modified workflow JSON.
Keep all unchanged nodes and connections intact. Only add, remove, or change what the user asked for.`;

  const response = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: fullPrompt,
    temperature: 0,
    responseFormat: { type: "json_object" },
  });

  return parseWorkflowResponse(response);
}

export function collectExistingNodeDefinitions(workflow: N8nWorkflow): NodeDefinition[] {
  const defs: NodeDefinition[] = [];
  const seen = new Set<string>();

  for (const node of workflow.nodes) {
    if (seen.has(node.type)) {
      continue;
    }
    seen.add(node.type);

    const def = getNodeDefinition(node.type);
    if (def) {
      defs.push(def);
    } else {
      logger.warn(
        { src: "plugin:n8n:generation:modify" },
        `No catalog definition found for node type "${node.type}" — LLM will have limited context for this node`
      );
    }
  }

  return defs;
}

export async function formatActionResponse(
  runtime: IAgentRuntime,
  responseType: string,
  data: Record<string, unknown>
): Promise<string> {
  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `${ACTION_RESPONSE_SYSTEM_PROMPT}\n\nType: ${responseType}\n\n${JSON.stringify(data)}`,
    });

    return (response as string).trim();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { src: "plugin:n8n:generation:format", error: errMsg, responseType },
      `formatActionResponse LLM call failed: ${errMsg}`
    );
    // Return a fallback message so the action can still communicate with the user
    if (responseType === "ERROR") {
      return `An error occurred: ${data.error || "Unknown error"}`;
    }
    return `Operation completed (type: ${responseType})`;
  }
}

export async function assessFeasibility(
  runtime: IAgentRuntime,
  userPrompt: string,
  removedNodes: NodeSearchResult[],
  remainingNodes: NodeSearchResult[]
): Promise<FeasibilityResult> {
  const removedList = removedNodes
    .filter((r) => r.node.credentials?.length)
    .map((r) => r.node.displayName)
    .join(", ");

  const availableList = remainingNodes
    .filter((r) => r.node.credentials?.length)
    .map((r) => r.node.displayName)
    .join(", ");

  const utilityList = remainingNodes
    .filter((r) => !r.node.credentials?.length)
    .map((r) => r.node.displayName)
    .join(", ");

  try {
    const result = (await runtime.useModel(ModelType.OBJECT_SMALL, {
      prompt:
        `${FEASIBILITY_CHECK_PROMPT}\n\n## User Request\n${userPrompt}` +
        `\n\n## Removed Integrations (unavailable)\n${removedList}` +
        `\n\n## Available Service Integrations\n${availableList}` +
        `\n\n## Available Utility Nodes\n${utilityList}`,
      schema: feasibilitySchema,
    })) as FeasibilityResult;

    return result;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { src: "plugin:n8n:generation:feasibility", error: errMsg },
      `Feasibility assessment LLM call failed: ${errMsg}`
    );
    return {
      feasible: false,
      reason: `Feasibility check failed: ${errMsg}`,
    };
  }
}
