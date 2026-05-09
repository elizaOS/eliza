#!/usr/bin/env npx ts-node
/**
 * Capture trigger output schemas by executing real workflows.
 *
 * Uses defaultNodes.json (the plugin's node catalog) to build test workflows —
 * no regex parsing of node source files needed.
 *
 * Flow:
 * 1. Read trigger definitions from defaultNodes.json
 * 2. Match triggers with available credentials
 * 3. For each match: create workflow (trigger → NoOp), activate, wait, capture
 * 4. Save schemas to triggerSchemaIndex.json
 *
 * Usage:
 *   WORKFLOW_HOST=http://localhost:5678 WORKFLOW_API_KEY=xxx bun run scripts/crawl-triggers-live.ts
 *
 * Options:
 *   --trigger=gmail          Only capture triggers matching this name
 *   --timeout=60             Max seconds to wait per trigger (default: 30)
 *   --keep                   Don't delete test workflows after capture
 *   --create-only            Create workflows but don't activate (for manual debug)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKFLOW_HOST = process.env.WORKFLOW_HOST;
const WORKFLOW_API_KEY = process.env.WORKFLOW_API_KEY;

if (!WORKFLOW_HOST || !WORKFLOW_API_KEY) {
  console.error("Missing WORKFLOW_HOST or WORKFLOW_API_KEY environment variables");
  process.exit(1);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SchemaProperty {
  type: string;
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
}

interface TriggerOutputSchema {
  type: "object";
  properties: Record<string, SchemaProperty>;
}

interface TriggerSchemaEntry {
  outputSchema: TriggerOutputSchema;
}

interface TriggerSchemaIndex {
  version: string;
  generatedAt: string;
  source: "execution";
  triggers: Record<string, TriggerSchemaEntry>;
  stats: {
    total: number;
    captured: number;
    failed: number;
    skipped: number;
  };
}

interface NodeDef {
  name: string;
  displayName: string;
  group: string[];
  version: number | number[];
  properties: Array<{
    name: string;
    type: string;
    default: unknown;
    required?: boolean;
    options?: Array<{ name: string; value: unknown }>;
    displayOptions?: {
      show?: Record<string, unknown[]>;
      hide?: Record<string, unknown[]>;
    };
  }>;
  credentials?: Array<{
    name: string;
    required: boolean;
    displayOptions?: { show?: Record<string, unknown[]> };
  }>;
  webhooks?: unknown[];
  polling?: boolean;
}

interface WorkflowExecution {
  id: string;
  finished: boolean;
  mode: string;
  status: string;
  startedAt: string;
  stoppedAt?: string;
  workflowId: string;
  data?: {
    resultData?: {
      runData?: Record<
        string,
        Array<{
          data: { main: Array<Array<{ json: Record<string, unknown> }>> };
        }>
      >;
    };
  };
}

// ─── n8n API ─────────────────────────────────────────────────────────────────

async function n8nRequest<T>(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const url = `${WORKFLOW_HOST}/api/v1${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": WORKFLOW_API_KEY!,
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  if (response.status === 204) return undefined as unknown as T;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`n8n ${method} ${endpoint}: ${response.status} ${text}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : (undefined as unknown as T);
}

// ─── Credentials map ────────────────────────────────────────────────────────
// Reads credential IDs from .credentials-map.json (created by create-credentials.ts).
// n8n cloud doesn't support GET /credentials, so IDs are persisted locally.

const CRED_MAP_PATH = path.join(__dirname, "..", ".credentials-map.json");

function loadCredentialsMap(): Record<string, string> {
  if (!fs.existsSync(CRED_MAP_PATH)) return {};
  const raw: Record<string, { id: string }> = JSON.parse(
    fs.readFileSync(CRED_MAP_PATH, "utf-8"),
  );
  // Flatten to { credType: id }
  const map: Record<string, string> = {};
  for (const [credType, entry] of Object.entries(raw)) {
    map[credType] = entry.id;
  }
  return map;
}

// ─── Trigger discovery from defaultNodes.json ────────────────────────────────

interface TriggerInfo {
  nodeType: string;
  displayName: string;
  triggerType: "webhook" | "polling" | "unknown";
  credentialTypes: string[];
  typeVersion: number;
  nodeDef: NodeDef;
}

function discoverTriggers(): TriggerInfo[] {
  const catalogPath = path.join(__dirname, "../src/data/defaultNodes.json");
  const nodes: NodeDef[] = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));

  return nodes
    .filter((n) => n.group?.includes("trigger"))
    .map((n) => {
      const triggerType: TriggerInfo["triggerType"] = n.webhooks?.length
        ? "webhook"
        : n.polling
          ? "polling"
          : "unknown";

      const version = Array.isArray(n.version)
        ? Math.max(...n.version)
        : n.version;

      const credentialTypes = (n.credentials || []).map((c) => c.name);

      return {
        nodeType: n.name,
        displayName: n.displayName,
        triggerType,
        credentialTypes,
        typeVersion: version,
        nodeDef: n,
      };
    });
}

/**
 * Build default parameters from a node definition.
 * Reads each property's `default` value. For dual-mode triggers (OAuth2 + API key),
 * sets `authentication` to the value that matches the OAuth2 credential.
 */
function buildDefaultParameters(
  nodeDef: NodeDef,
  matchedCredType: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (const prop of nodeDef.properties) {
    if (
      prop.default !== undefined &&
      prop.default !== "" &&
      prop.default !== null
    ) {
      params[prop.name] = prop.default;
    } else if (prop.type === "options" && prop.options?.length) {
      // For options fields with no default, pick the first option
      params[prop.name] = prop.options[0].value;
    }
  }

  // Find which authentication value activates our OAuth2 credential
  const authProp = nodeDef.properties.find((p) => p.name === "authentication");
  if (authProp && matchedCredType.toLowerCase().includes("oauth2")) {
    // Check credential displayOptions to find the right authentication value
    const cred = nodeDef.credentials?.find((c) => c.name === matchedCredType);
    if (cred?.displayOptions?.show?.authentication) {
      params.authentication = cred.displayOptions.show.authentication[0];
    } else if (authProp.options) {
      // Fall back to finding the oAuth2 option
      const oauthOption = authProp.options.find((o) =>
        String(o.value).toLowerCase().includes("oauth2"),
      );
      if (oauthOption) params.authentication = oauthOption.value;
    }
  }

  return params;
}

// ─── Workflow builder ────────────────────────────────────────────────────────

function buildTestWorkflow(
  trigger: TriggerInfo,
  matchedCredType: string,
  credentialId: string,
): Record<string, unknown> {
  const parameters = buildDefaultParameters(trigger.nodeDef, matchedCredType);

  return {
    name: `[Schema Capture] ${trigger.displayName}`,
    nodes: [
      {
        name: "Trigger",
        type: trigger.nodeType,
        typeVersion: trigger.typeVersion,
        position: [250, 300],
        parameters,
        credentials: {
          [matchedCredType]: { id: credentialId, name: matchedCredType },
        },
      },
      {
        name: "NoOp",
        type: "n8n-nodes-base.noOp",
        typeVersion: 1,
        position: [500, 300],
        parameters: {},
      },
    ],
    connections: {
      Trigger: {
        main: [[{ node: "NoOp", type: "main", index: 0 }]],
      },
    },
    settings: { executionOrder: "v1" },
  };
}

// ─── Schema extraction ──────────────────────────────────────────────────────

function inferSchemaFromValue(value: unknown): SchemaProperty {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "number")
    return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (Array.isArray(value)) {
    if (value.length === 0)
      return { type: "array", items: { type: "unknown" } };
    return { type: "array", items: inferSchemaFromValue(value[0]) };
  }
  if (typeof value === "object") {
    const properties: Record<string, SchemaProperty> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = inferSchemaFromValue(val);
    }
    return { type: "object", properties };
  }
  return { type: "unknown" };
}

function extractSchemaFromExecution(
  execution: WorkflowExecution,
): { schema: TriggerOutputSchema } | null {
  const runData = execution.data?.resultData?.runData;
  if (!runData) return null;

  const firstNodeData = Object.values(runData)[0];
  if (!firstNodeData?.[0]) return null;

  const mainOutput = firstNodeData[0]?.data?.main?.[0];
  if (!mainOutput?.[0]) return null;

  const json = mainOutput[0].json;
  if (!json || typeof json !== "object") return null;

  const properties: Record<string, SchemaProperty> = {};
  for (const [key, value] of Object.entries(json)) {
    properties[key] = inferSchemaFromValue(value);
  }

  return { schema: { type: "object", properties } };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filterTrigger = args
    .find((a) => a.startsWith("--trigger="))
    ?.split("=")[1];
  const timeoutSec = parseInt(
    args.find((a) => a.startsWith("--timeout="))?.split("=")[1] ?? "30",
  );
  const keepWorkflows = args.includes("--keep");
  const createOnly = args.includes("--create-only");
  const fromExisting = args.includes("--from-existing");

  console.log(`n8n: ${WORKFLOW_HOST}`);
  console.log(
    `Timeout: ${timeoutSec}s | Keep: ${keepWorkflows} | Create-only: ${createOnly} | From-existing: ${fromExisting}`,
  );
  if (filterTrigger) console.log(`Filter: ${filterTrigger}`);
  console.log();

  // Step 1: Build credential map from .credentials-map.json
  const credByType = new Map(Object.entries(loadCredentialsMap()));

  // Step 2: Discover triggers from defaultNodes.json
  let triggers = discoverTriggers();
  if (filterTrigger) {
    triggers = triggers.filter((t) =>
      t.nodeType.toLowerCase().includes(filterTrigger.toLowerCase()),
    );
  }

  // Step 3: Check for existing [Schema Capture] workflows first
  const existingWorkflows = await findExistingCaptureWorkflows();

  // In --from-existing mode, we don't need credentials — just match by existing workflows.
  // Otherwise, filter to triggers that have credentials in the local map.
  const activeTriggers = fromExisting
    ? triggers.filter((t) =>
        existingWorkflows.some((w) => w.triggerType === t.nodeType),
      )
    : triggers.filter((t) =>
        t.credentialTypes.some((ct) => credByType.has(ct)),
      );

  console.log(
    fromExisting
      ? `${activeTriggers.length} triggers with existing [Schema Capture] workflows\n`
      : `${activeTriggers.length} triggers with matching credentials\n`,
  );

  const result: TriggerSchemaIndex = {
    version: "2.0.0",
    generatedAt: new Date().toISOString(),
    source: "execution",
    triggers: {},
    stats: { total: activeTriggers.length, captured: 0, failed: 0, skipped: 0 },
  };

  for (const trigger of activeTriggers) {
    const credType =
      trigger.credentialTypes.find((ct) => credByType.has(ct)) ||
      trigger.credentialTypes[0] ||
      "";
    const credId = credByType.get(credType) || "";

    console.log(`── ${trigger.displayName} ──`);

    // Check if there's an existing workflow with executions
    const existingWf = existingWorkflows.find(
      (w) => w.triggerType === trigger.nodeType,
    );

    // Use existing workflow or create a new one
    let workflowId: string | null = existingWf?.id ?? null;

    if (existingWf) {
      console.log(`   Existing workflow: ${existingWf.id}`);
      // Check if it already has execution data
      const schema = await captureFromWorkflow(existingWf.id);
      if (schema) {
        result.triggers[trigger.nodeType] = {
          outputSchema: schema.schema,
        };
        result.stats.captured++;
        const fields = Object.keys(schema.schema.properties);
        console.log(
          `   Captured ${fields.length} fields: ${fields.slice(0, 8).join(", ")}...`,
        );
        console.log();
        continue;
      }
      console.log(`   No execution yet`);
      if (fromExisting) {
        console.log(`   Skipped (--from-existing)`);
        result.stats.skipped++;
        console.log();
        continue;
      }
      console.log(`   Activating...`);
    }

    if (fromExisting) {
      console.log(`   No existing workflow — skipped (--from-existing)`);
      result.stats.skipped++;
      console.log();
      continue;
    }

    if (createOnly) {
      if (!workflowId) {
        try {
          const workflow = buildTestWorkflow(trigger, credType, credId);
          const created = await n8nRequest<{ id: string }>(
            "POST",
            "/workflows",
            workflow,
          );
          workflowId = created.id;
          console.log(
            `   Created: ${workflowId} (${WORKFLOW_HOST}/workflow/${workflowId})`,
          );
        } catch (error) {
          console.log(
            `   ERROR creating: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      result.stats.skipped++;
      console.log();
      continue;
    }

    // Create if needed, activate, wait
    const isNew = !workflowId;
    try {
      if (!workflowId) {
        const workflow = buildTestWorkflow(trigger, credType, credId);
        const created = await n8nRequest<{ id: string }>(
          "POST",
          "/workflows",
          workflow,
        );
        workflowId = created.id;
        console.log(`   Created: ${workflowId}`);
      }

      await n8nRequest("POST", `/workflows/${workflowId}/activate`);
      console.log(`   Activated. Waiting ${timeoutSec}s...`);

      if (trigger.triggerType === "webhook") {
        console.log(`   WEBHOOK: trigger an event from the service now`);
      }

      const schema = await waitForExecution(workflowId, timeoutSec);
      if (schema) {
        result.triggers[trigger.nodeType] = {
          outputSchema: schema.schema,
        };
        result.stats.captured++;
        const fields = Object.keys(schema.schema.properties);
        console.log(
          `   Captured ${fields.length} fields: ${fields.slice(0, 8).join(", ")}...`,
        );
      } else {
        result.stats.failed++;
        console.log(`   No execution data (timeout)`);
      }
    } catch (error) {
      result.stats.failed++;
      console.log(
        `   ERROR: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      if (workflowId) {
        try {
          await n8nRequest("POST", `/workflows/${workflowId}/deactivate`);
        } catch {
          /* ignore */
        }
        // Only delete if we created it and --keep is not set
        if (isNew && !keepWorkflows) {
          try {
            await n8nRequest("DELETE", `/workflows/${workflowId}`);
          } catch {
            /* ignore */
          }
        }
      }
    }

    console.log();
  }

  // Save results
  const outputPath = path.join(
    __dirname,
    "../src/data/triggerSchemaIndex.json",
  );

  // Merge with existing
  if (fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    if (existing.triggers) {
      for (const [key, value] of Object.entries(existing.triggers)) {
        if (!result.triggers[key]) {
          result.triggers[key] = value as TriggerSchemaEntry;
        }
      }
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log("══════════════════════════════════════");
  console.log(`Captured: ${result.stats.captured}`);
  console.log(`Failed: ${result.stats.failed}`);
  console.log(`Skipped: ${result.stats.skipped}`);
  console.log(`Total in index: ${Object.keys(result.triggers).length}`);
  console.log(`Saved to ${outputPath}`);
}

/**
 * Find existing [Schema Capture] workflows and identify their trigger type.
 */
async function findExistingCaptureWorkflows(): Promise<
  Array<{ id: string; triggerType: string }>
> {
  try {
    interface WorkflowListItem {
      id: string;
      name: string;
      nodes: Array<{ type: string; name: string }>;
    }
    const { data } = await n8nRequest<{ data: WorkflowListItem[] }>(
      "GET",
      "/workflows?limit=50",
    );
    return data
      .filter((w) => w.name.startsWith("[Schema Capture]"))
      .map((w) => {
        const triggerNode = w.nodes?.find((n) => n.name === "Trigger");
        return { id: w.id, triggerType: triggerNode?.type || "" };
      })
      .filter((w) => w.triggerType);
  } catch {
    return [];
  }
}

/**
 * Capture schema from an existing workflow's latest successful execution.
 */
async function captureFromWorkflow(
  workflowId: string,
): Promise<{ schema: TriggerOutputSchema } | null> {
  try {
    const { data: executions } = await n8nRequest<{ data: WorkflowExecution[] }>(
      "GET",
      `/executions?workflowId=${workflowId}&includeData=true&limit=1`,
    );

    if (executions.length === 0) return null;

    const exec = executions[0];
    if (exec.status !== "success" || !exec.finished) return null;

    const fullExec = await n8nRequest<WorkflowExecution>(
      "GET",
      `/executions/${exec.id}?includeData=true`,
    );
    return extractSchemaFromExecution(fullExec);
  } catch {
    return null;
  }
}

async function waitForExecution(
  workflowId: string,
  timeoutSec: number,
): Promise<{ schema: TriggerOutputSchema } | null> {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeoutSec * 1000) {
    const { data: executions } = await n8nRequest<{ data: WorkflowExecution[] }>(
      "GET",
      `/executions?workflowId=${workflowId}&includeData=true&limit=1`,
    );

    if (executions.length > 0) {
      const exec = executions[0];
      if (exec.status === "success" && exec.finished) {
        const fullExec = await n8nRequest<WorkflowExecution>(
          "GET",
          `/executions/${exec.id}?includeData=true`,
        );
        return extractSchemaFromExecution(fullExec);
      }
      if (exec.status === "error") {
        console.log(`   Execution error`);
        return null;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return null;
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
