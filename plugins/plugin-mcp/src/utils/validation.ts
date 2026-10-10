/**
 * Validators for model-produced tool/resource selections and the feedback prompts
 * used to re-prompt on failure. Selections target a connected server. Tools must
 * exist and their arguments must satisfy the tool schema; resource URIs are
 * resolved by the server. Explicit noTool/noResourceAvailable signals are valid.
 */

import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { State } from "@elizaos/core";
import { validateJsonSchema } from "../protocol-utils/json.js";
import {
  createMcpResourceSelectionFeedback,
  validateMcpResourceSelection,
} from "../protocol-utils/resource-selection.js";
import { getMcpJsonSchemaBudgetError } from "../protocol-utils/schema-budget.js";
import type { McpProviderData, McpServerInfo, ValidationResult } from "../types";
import {
  type ResourceSelection,
  type ToolSelectionArgument,
  type ToolSelectionName,
  toolSelectionArgumentSchema,
  toolSelectionNameSchema,
} from "./schemas";

export type { ResourceSelection } from "./schemas";
export interface ToolSelection {
  readonly serverName: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly reasoning?: string;
  readonly noToolAvailable?: boolean;
}
const MAX_TOOL_ARGUMENTS_JSON_BYTES = 1024 * 1024;
const TOOL_SCHEMA_VALIDATION_TIMEOUT_MS = 250;
const TOOL_SCHEMA_WORKER_STARTUP_TIMEOUT_MS = 2000;
const MAX_CONCURRENT_SCHEMA_VALIDATIONS = 4;
let activeSchemaValidations = 0;
const moduleRequire = createRequire(import.meta.url);
const AJV_WORKER_MODULE_PATH = moduleRequire.resolve("ajv");
const AJV_2020_WORKER_MODULE_PATH = moduleRequire.resolve("ajv/dist/2020");
interface SchemaWorkerResult {
  readonly success: boolean;
  readonly error?: string;
}
const SCHEMA_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const AjvImport = require(workerData.ajvModulePath);
  const AjvLegacy = AjvImport.default ?? AjvImport;
  const Ajv2020Import = require(workerData.ajv2020ModulePath);
  const Ajv2020 = Ajv2020Import.default ?? Ajv2020Import;

  parentPort.postMessage({ ready: true });
  parentPort.once("message", ({ schemaJson, dataJson }) => {
    try {
      const schema = JSON.parse(schemaJson);
      const data = JSON.parse(dataJson);
      const dialect = typeof schema.$schema === "string"
        ? schema.$schema.replace(/#$/, "") : schema.$schema;
      // MCP defaults to 2020-12. Keep draft-07 only when it is declared.
      // Each request still has its own bounded worker and Ajv instance.
      let Ajv = Ajv2020;
      if (dialect !== undefined && dialect !== "https://json-schema.org/draft/2020-12/schema") {
        if (dialect !== "http://json-schema.org/draft-07/schema") {
          throw new Error("Unsupported MCP JSON Schema dialect: " + String(dialect));
        }
        Ajv = AjvLegacy;
      }
      // "format" is an annotation by default; without format definitions Ajv
      // refuses the whole schema ("unknown format"), so every call fails.
      const options = { allErrors: true, validateFormats: false };
      let validate;
      try {
        validate = new Ajv(options).compile(schema);
      } catch (error) {
        // error-policy:J3 undeclared legacy schemas keep their original constraints.
        // Only compilation can fall back; failed argument validation never does.
        if (dialect !== undefined) throw error;
        validate = new AjvLegacy(options).compile(schema);
      }
      const valid = validate(data);
      parentPort.postMessage({ success: Boolean(valid), errors: validate.errors ?? [] });
    } catch (error) {
      parentPort.postMessage({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
`;
function serializeToolArguments(data: unknown):
  | {
      success: true;
      json: string;
    }
  | {
      success: false;
      error: string;
    } {
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    // error-policy:J3 model-produced tool arguments must be finite JSON
    return { success: false, error: "Tool arguments are not JSON-serializable" };
  }
  if (json === undefined) {
    return { success: false, error: "Tool arguments are not JSON-serializable" };
  }
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_TOOL_ARGUMENTS_JSON_BYTES) {
    return {
      success: false,
      error: `Tool arguments serialized size ${bytes} exceeds ${MAX_TOOL_ARGUMENTS_JSON_BYTES}`,
    };
  }
  return { success: true, json };
}
function formatWorkerErrors(errors: unknown): string {
  if (!Array.isArray(errors)) return "validation failed";
  return errors
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return "validation failed";
      const error = entry as {
        instancePath?: unknown;
        dataPath?: unknown;
        message?: unknown;
      };
      const rawPath =
        typeof error.instancePath === "string"
          ? error.instancePath
          : typeof error.dataPath === "string"
            ? error.dataPath
            : "";
      const path = rawPath ? rawPath.replace(/^\//, "") : "value";
      const message = typeof error.message === "string" ? error.message : "validation failed";
      return `${path}: ${message}`;
    })
    .join(", ");
}
async function validateUntrustedToolArguments(
  data: unknown,
  schema: Readonly<Record<string, unknown>>
): Promise<ValidationResult<unknown>> {
  const schemaBudgetError = getMcpJsonSchemaBudgetError(schema);
  if (schemaBudgetError) return { success: false, error: schemaBudgetError };
  let schemaJson: string;
  try {
    schemaJson = JSON.stringify(schema);
  } catch {
    // error-policy:J3 schema serialization can fail if a mutable input changes after preflight
    return { success: false, error: "MCP JSON schema is not JSON-serializable" };
  }
  const serialized = serializeToolArguments(data);
  if (!serialized.success) return serialized;
  if (activeSchemaValidations >= MAX_CONCURRENT_SCHEMA_VALIDATIONS) {
    return {
      success: false,
      error: `MCP JSON schema validation capacity of ${MAX_CONCURRENT_SCHEMA_VALIDATIONS} exceeded`,
    };
  }
  activeSchemaValidations += 1;
  try {
    return await new Promise<ValidationResult<unknown>>((resolve) => {
      const worker = new Worker(SCHEMA_WORKER_SOURCE, {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        workerData: {
          ajvModulePath: AJV_WORKER_MODULE_PATH,
          ajv2020ModulePath: AJV_2020_WORKER_MODULE_PATH,
        },
      });
      let settled = false;
      let evaluationTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: ValidationResult<unknown>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        if (evaluationTimer) clearTimeout(evaluationTimer);
        worker.removeAllListeners();
        void worker.terminate().then(
          () => resolve(result),
          () => resolve(result)
        );
      };
      const startupTimer = setTimeout(() => {
        finish({
          success: false,
          error: `MCP JSON schema validation worker startup exceeded ${TOOL_SCHEMA_WORKER_STARTUP_TIMEOUT_MS}ms`,
        });
      }, TOOL_SCHEMA_WORKER_STARTUP_TIMEOUT_MS);
      worker.on(
        "message",
        (
          message: SchemaWorkerResult & {
            ready?: boolean;
            errors?: unknown;
          }
        ) => {
          if (message.ready) {
            clearTimeout(startupTimer);
            evaluationTimer = setTimeout(() => {
              finish({
                success: false,
                error: `MCP JSON schema validation exceeded ${TOOL_SCHEMA_VALIDATION_TIMEOUT_MS}ms`,
              });
            }, TOOL_SCHEMA_VALIDATION_TIMEOUT_MS);
            worker.postMessage({ schemaJson, dataJson: serialized.json });
            return;
          }
          if (message.success) {
            finish({ success: true, data });
          } else if (message.error) {
            finish({ success: false, error: `schema validation failed: ${message.error}` });
          } else {
            finish({ success: false, error: formatWorkerErrors(message.errors) });
          }
        }
      );
      worker.once("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        finish({ success: false, error: `schema validation failed: ${message}` });
      });
      worker.once("exit", (code) => {
        if (!settled) {
          finish({ success: false, error: `schema validation worker exited with code ${code}` });
        }
      });
    });
  } catch (error) {
    // error-policy:J3 worker startup failures are explicit validation failures
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `schema validation worker failed to start: ${message}` };
  } finally {
    activeSchemaValidations -= 1;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalReasoning(parsed: Record<string, unknown>): {
  readonly reasoning?: string;
} {
  return typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {};
}
export function validateToolSelectionName(
  parsed: unknown,
  state: State
): ValidationResult<ToolSelectionName> {
  if (isRecord(parsed) && parsed.noToolAvailable === true) {
    return {
      success: true,
      data: {
        serverName: "",
        toolName: "",
        noToolAvailable: true,
        ...optionalReasoning(parsed),
      },
    };
  }
  const basicResult = validateJsonSchema<ToolSelectionName>(parsed, toolSelectionNameSchema);
  if (basicResult.success === false) {
    return { success: false, error: basicResult.error };
  }
  const data = basicResult.data;
  const mcpData = (state.values.mcp ?? {}) as Record<string, McpServerInfo>;
  const server = mcpData[data.serverName];
  if (server?.status !== "connected") {
    return {
      success: false,
      error: `Server "${data.serverName}" not found or not connected`,
    };
  }
  const toolInfo = server.tools?.[data.toolName];
  if (!toolInfo) {
    return {
      success: false,
      error: `Tool "${data.toolName}" not found on server "${data.serverName}"`,
    };
  }
  return { success: true, data };
}
export async function validateToolSelectionArgument(
  parsed: unknown,
  toolInputSchema: Readonly<Record<string, unknown>>
): Promise<ValidationResult<ToolSelectionArgument>> {
  const normalizedParsed =
    isRecord(parsed) &&
    typeof parsed.toolArguments === "string" &&
    ["", "{}"].includes(parsed.toolArguments.trim())
      ? { ...parsed, toolArguments: {} }
      : parsed;
  const basicResult = validateJsonSchema<ToolSelectionArgument>(
    normalizedParsed,
    toolSelectionArgumentSchema
  );
  if (basicResult.success === false) {
    return { success: false, error: basicResult.error };
  }
  const data = basicResult.data;
  const validationResult = await validateUntrustedToolArguments(
    data.toolArguments,
    toolInputSchema
  );
  if (validationResult.success === false) {
    return {
      success: false,
      error: `Invalid arguments: ${validationResult.error}`,
    };
  }
  return { success: true, data };
}
export function validateResourceSelection(
  selection: unknown,
  state: State
): ValidationResult<ResourceSelection> {
  const basicResult = validateMcpResourceSelection(
    selection
  ) as ValidationResult<ResourceSelection>;
  if (basicResult.success === false || basicResult.data.noResourceAvailable) {
    return basicResult;
  }
  const data = basicResult.data;
  // Resource links and template-derived URIs need not appear in resources/list.
  // Validate the selected connection here; the server resolves the resource.
  const mcpData = (state.values.mcp ?? {}) as Record<string, McpServerInfo>;
  const name = data.serverName ?? "";
  if (!Object.hasOwn(mcpData, name) || mcpData[name]?.status !== "connected") {
    return {
      success: false,
      error: `Server "${data.serverName}" not found or not connected`,
    };
  }
  return basicResult;
}
interface ToolDescription {
  readonly description?: string;
}
export function createToolSelectionFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  composedState: State,
  userMessage: string
): string {
  let toolsDescription = "";
  const mcpData = composedState.values.mcp as Record<string, McpProviderData[string]> | undefined;
  if (mcpData) {
    for (const [serverName, server] of Object.entries(mcpData)) {
      if (server.status !== "connected") continue;
      const tools = server.tools as Record<string, ToolDescription> | undefined;
      if (tools) {
        for (const [toolName, tool] of Object.entries(tools)) {
          toolsDescription += `Tool: ${toolName} (Server: ${serverName})\n`;
          toolsDescription += `Description: ${tool.description ?? "No description available"}\n\n`;
        }
      }
    }
  }
  return createFeedbackPrompt(
    originalResponse,
    errorMessage,
    "tool",
    toolsDescription,
    userMessage
  );
}
export function createResourceSelectionFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  composedState: State,
  userMessage: string
): string {
  const mcpData = composedState.values.mcp as Record<string, McpProviderData[string]> | undefined;
  return createMcpResourceSelectionFeedback({
    originalResponse,
    errorMessage,
    providerData: mcpData ?? {},
    userMessage,
  });
}
function createFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  itemType: string,
  itemsDescription: string,
  userMessage: string
): string {
  return `The previous ${itemType} selection could not be parsed or validated: ${errorMessage}

Your original response:
${originalResponse}

Reply again as compact JSON for ${itemType} selection.
Available ${itemType}s:
${itemsDescription}

User request: ${userMessage}

Use exact names from the list. For tools, return a JSON object with serverName, toolName, reasoning, and noToolAvailable. For resources, return a JSON object with serverName, uri, reasoning, and noResourceAvailable.`;
}
