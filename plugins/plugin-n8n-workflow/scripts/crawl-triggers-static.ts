#!/usr/bin/env npx ts-node
/**
 * Crawler to extract output schemas from n8n trigger nodes.
 *
 * Fully dynamic — no hardcoded schema names.
 *
 * Strategy:
 * 1. Find all *Trigger.node.js files in n8n-nodes-base
 * 2. Detect trigger type (webhook vs polling)
 * 3. Extract API URLs from trigger + GenericFunctions.js code
 * 4. Match URLs to APIs.guru entries
 * 5. For polling: find API endpoint path in OpenAPI spec → extract response schema
 * 6. For webhook: find "event"/"webhook" schema in OpenAPI spec
 * 7. Detect n8n transformations (simplifyOutput, etc.) and apply them
 * 8. Save to triggerSchemaIndex.json
 *
 * Usage: bun run scripts/crawl-triggers-static.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const N8N_NODES_PATH = path.join(
  __dirname,
  "../node_modules/n8n-nodes-base/dist/nodes",
);
const CACHE_DIR = path.join(__dirname, "../.cache/openapi");

// ─── Types ───────────────────────────────────────────────────────────────────

interface SchemaProperty {
  type: string;
  description?: string;
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
}

interface TriggerOutputSchema {
  type: "object";
  properties: Record<string, SchemaProperty>;
}

interface TriggerSchemaEntry {
  triggerType: "webhook" | "polling" | "unknown";
  serviceName: string | null;
  openApiSource: string | null;
  schemaSource: string | null; // How we found the schema (path match, event schema, etc.)
  hasTransformation: boolean;
  transformationFunction: string | null;
  outputSchema: TriggerOutputSchema | null;
  confidence: "high" | "medium" | "low";
  reason?: string;
}

interface TriggerSchemaIndex {
  version: string;
  generatedAt: string;
  triggers: Record<string, TriggerSchemaEntry>;
  stats: {
    total: number;
    withSchema: number;
    withoutSchema: number;
    webhook: number;
    polling: number;
    unknown: number;
  };
}

interface OpenApiSpec {
  components?: {
    schemas?: Record<string, OpenApiSchemaObj>;
  };
  definitions?: Record<string, OpenApiSchemaObj>; // Swagger 2.0
  paths?: Record<string, Record<string, OpenApiMethodObj>>;
  webhooks?: Record<string, unknown>;
}

interface OpenApiMethodObj {
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: OpenApiSchemaObj }>;
      schema?: OpenApiSchemaObj; // Swagger 2.0
    }
  >;
}

interface OpenApiSchemaObj {
  type?: string;
  properties?: Record<string, OpenApiSchemaObj>;
  items?: OpenApiSchemaObj;
  description?: string;
  $ref?: string;
  allOf?: OpenApiSchemaObj[];
  oneOf?: OpenApiSchemaObj[];
  anyOf?: OpenApiSchemaObj[];
  enum?: string[];
  nullable?: boolean;
}

// ─── APIs.guru ───────────────────────────────────────────────────────────────

interface ApisGuruEntry {
  preferred: string;
  versions: Record<
    string,
    {
      swaggerUrl: string;
      openapiVer: string;
      info: {
        title: string;
        "x-providerName"?: string;
        "x-serviceName"?: string;
      };
    }
  >;
}

type ApisGuruIndex = Record<string, ApisGuruEntry>;

let cachedGuruIndex: ApisGuruIndex | null = null;

async function loadApisGuruIndex(): Promise<ApisGuruIndex> {
  if (cachedGuruIndex) return cachedGuruIndex;

  const cachePath = path.join(CACHE_DIR, "apis-guru-index.json");
  if (fs.existsSync(cachePath)) {
    const stat = fs.statSync(cachePath);
    const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    if (ageHours < 24) {
      cachedGuruIndex = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      return cachedGuruIndex!;
    }
  }

  console.log("Fetching APIs.guru index...");
  const response = await fetch("https://api.apis.guru/v2/list.json");
  cachedGuruIndex = (await response.json()) as ApisGuruIndex;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cachedGuruIndex));
  console.log(`Cached (${Object.keys(cachedGuruIndex!).length} APIs)\n`);

  return cachedGuruIndex!;
}

async function fetchOpenApiSpec(
  apisGuruKey: string,
): Promise<OpenApiSpec | null> {
  const index = await loadApisGuruIndex();
  const entry = index[apisGuruKey];
  if (!entry) return null;

  const cachePath = path.join(
    CACHE_DIR,
    `${apisGuruKey.replace(/[/:]/g, "_")}.json`,
  );
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  }

  const version = entry.versions[entry.preferred];
  if (!version) return null;

  console.log(`    Fetching: ${apisGuruKey} (${entry.preferred})`);
  const response = await fetch(version.swaggerUrl);
  if (!response.ok) return null;

  const spec = (await response.json()) as OpenApiSpec;
  fs.writeFileSync(cachePath, JSON.stringify(spec));
  return spec;
}

// ─── Dynamic Service Detection ──────────────────────────────────────────────

/**
 * Extract API base URLs from trigger code + GenericFunctions.js.
 * Returns domains like "api.stripe.com", "www.googleapis.com", etc.
 */
function extractApiDomains(triggerPath: string): string[] {
  const domains: string[] = [];

  // Read trigger file
  const triggerCode = fs.readFileSync(triggerPath, "utf-8");

  // Read GenericFunctions.js from same and parent directories
  const dir = path.dirname(triggerPath);
  const genericPaths = [
    path.join(dir, "GenericFunctions.js"),
    path.join(dir, "..", "GenericFunctions.js"),
  ];

  let allCode = triggerCode;
  for (const gp of genericPaths) {
    if (fs.existsSync(gp)) {
      allCode += "\n" + fs.readFileSync(gp, "utf-8");
    }
  }

  // Extract all URL domains
  const urlPattern = /['"`]https?:\/\/([a-zA-Z0-9.-]+)/g;
  for (const match of allCode.matchAll(urlPattern)) {
    const domain = match[1];
    // Skip n8n.io, docs, icons, cdn
    if (
      domain.includes("n8n.io") ||
      domain.includes("docs.") ||
      domain.includes("cdn.") ||
      domain.includes("icon") ||
      domain.includes("support.")
    ) {
      continue;
    }
    if (!domains.includes(domain)) {
      domains.push(domain);
    }
  }

  return domains;
}

/**
 * Extract API endpoint paths from code.
 * E.g., "/gmail/v1/users/me/messages" or "/v1/events"
 */
function extractApiEndpoints(triggerPath: string): string[] {
  const triggerCode = fs.readFileSync(triggerPath, "utf-8");
  const endpoints: string[] = [];

  // Pattern: apiRequest('GET', '/some/path')
  const endpointPattern =
    /(?:apiRequest|googleApiRequest)[\s\S]{0,50}?['"](?:GET|POST)['"][\s\S]{0,30}?['"](\/[a-zA-Z0-9/{}$._-]+)['"]/g;
  for (const match of triggerCode.matchAll(endpointPattern)) {
    endpoints.push(match[1]);
  }

  // Pattern: endpoint = '/some/path'
  const endpointVarPattern = /endpoint\s*=\s*['"`](\/[a-zA-Z0-9/{}._-]+)['"`]/g;
  for (const match of triggerCode.matchAll(endpointVarPattern)) {
    endpoints.push(match[1]);
  }

  return endpoints;
}

/**
 * Map a domain to an APIs.guru key.
 * "api.stripe.com" → "stripe.com"
 * "www.googleapis.com" + endpoint "/gmail/..." → "googleapis.com:gmail"
 */
function domainToApisGuruKey(
  domain: string,
  endpoints: string[],
  index: ApisGuruIndex,
): string | null {
  // Try direct match: "api.stripe.com" → "stripe.com"
  const baseDomain = domain.replace(/^(api|www|app)\./, "");

  if (index[baseDomain]) return baseDomain;

  // For googleapis.com, use the endpoint to determine the service
  if (baseDomain === "googleapis.com") {
    for (const ep of endpoints) {
      // /gmail/v1/... → googleapis.com:gmail
      const serviceMatch = ep.match(/^\/(\w+)\//);
      if (serviceMatch) {
        const key = `googleapis.com:${serviceMatch[1]}`;
        if (index[key]) return key;
      }
    }
    return null;
  }

  // Try with service name variations
  for (const guruKey of Object.keys(index)) {
    if (guruKey.startsWith(baseDomain)) return guruKey;
  }

  return null;
}

// ─── Schema Extraction ──────────────────────────────────────────────────────

function resolveRef(spec: OpenApiSpec, ref: string): OpenApiSchemaObj | null {
  const parts = ref.replace("#/", "").split("/");
  let current: unknown = spec;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return (current as OpenApiSchemaObj) ?? null;
}

function extractSchemaProperties(
  spec: OpenApiSpec,
  schema: OpenApiSchemaObj,
  depth = 0,
): Record<string, SchemaProperty> {
  if (depth > 4) return {};

  if (schema.$ref) {
    const resolved = resolveRef(spec, schema.$ref);
    if (!resolved) return {};
    return extractSchemaProperties(spec, resolved, depth);
  }

  if (schema.allOf) {
    const merged: Record<string, SchemaProperty> = {};
    for (const sub of schema.allOf) {
      Object.assign(merged, extractSchemaProperties(spec, sub, depth + 1));
    }
    return merged;
  }

  if (schema.oneOf?.[0]) {
    return extractSchemaProperties(spec, schema.oneOf[0], depth + 1);
  }
  if (schema.anyOf?.[0]) {
    return extractSchemaProperties(spec, schema.anyOf[0], depth + 1);
  }

  const properties = schema.properties;
  if (!properties) return {};

  const result: Record<string, SchemaProperty> = {};
  for (const [key, prop] of Object.entries(properties)) {
    result[key] = convertProperty(spec, prop, depth + 1);
  }
  return result;
}

function convertProperty(
  spec: OpenApiSpec,
  prop: OpenApiSchemaObj,
  depth: number,
): SchemaProperty {
  if (depth > 4) return { type: "unknown" };

  if (prop.$ref) {
    const resolved = resolveRef(spec, prop.$ref);
    if (!resolved) return { type: "unknown" };
    return convertProperty(spec, resolved, depth);
  }

  const type = prop.type ?? "unknown";

  if (type === "object" && prop.properties) {
    return {
      type: "object",
      description: prop.description,
      properties: extractSchemaProperties(spec, prop, depth),
    };
  }

  if (type === "array" && prop.items) {
    return {
      type: "array",
      description: prop.description,
      items: convertProperty(spec, prop.items, depth + 1),
    };
  }

  return { type, description: prop.description };
}

/**
 * DYNAMIC: For polling triggers, find the schema from the API endpoint path.
 * Matches endpoint path to OpenAPI paths → extracts 200 response schema.
 */
function extractSchemaFromEndpoint(
  spec: OpenApiSpec,
  endpoints: string[],
): { schema: TriggerOutputSchema; source: string } | null {
  const specPaths = spec.paths;
  if (!specPaths) return null;

  for (const endpoint of endpoints) {
    // Normalize: replace template vars ${xxx} with {xxx}
    const normalized = endpoint.replace(/\$\{[^}]+\}/g, "{id}");

    for (const [specPath, methods] of Object.entries(specPaths)) {
      // Match paths: /gmail/v1/users/{userId}/messages/{id}
      // against:     /gmail/v1/users/me/messages/${message.id}
      if (!pathsMatch(normalized, specPath)) continue;

      const methodObj = methods as Record<string, OpenApiMethodObj>;
      const getMethod = methodObj["get"] ?? methodObj["post"];
      if (!getMethod?.responses) continue;

      const resp200 = getMethod.responses["200"] ?? getMethod.responses["201"];
      if (!resp200) continue;

      // OpenAPI 3.x: content.application/json.schema
      let responseSchema: OpenApiSchemaObj | null = null;
      if (resp200.content) {
        const jsonContent =
          resp200.content["application/json"] ?? resp200.content["*/*"];
        responseSchema = jsonContent?.schema ?? null;
      }
      // Swagger 2.0: schema directly on response
      if (!responseSchema && resp200.schema) {
        responseSchema = resp200.schema;
      }

      if (!responseSchema) continue;

      const properties = extractSchemaProperties(spec, responseSchema);
      if (Object.keys(properties).length > 0) {
        return {
          schema: { type: "object", properties },
          source: `path:${specPath}`,
        };
      }
    }
  }

  return null;
}

/**
 * Match an n8n endpoint against an OpenAPI path pattern.
 * "/gmail/v1/users/me/messages/{id}" matches "/gmail/v1/users/{userId}/messages/{id}"
 */
function pathsMatch(n8nPath: string, specPath: string): boolean {
  const n8nParts = n8nPath.split("/").filter(Boolean);
  const specParts = specPath.split("/").filter(Boolean);

  if (n8nParts.length !== specParts.length) return false;

  for (let i = 0; i < n8nParts.length; i++) {
    const n8n = n8nParts[i];
    const spec = specParts[i];
    // Template params match anything
    if (spec.startsWith("{") || n8n.startsWith("{")) continue;
    // "me" matches "{userId}" equivalent
    if (n8n === "me" && spec.startsWith("{")) continue;
    if (n8n !== spec) return false;
  }

  return true;
}

/**
 * DYNAMIC: For webhook triggers, find an "event" or "webhook" schema.
 * Searches components/schemas for patterns like "event", "webhook_event", etc.
 */
function extractEventSchema(
  spec: OpenApiSpec,
): { schema: TriggerOutputSchema; source: string } | null {
  const schemas = spec.components?.schemas ?? spec.definitions ?? {};

  // Priority order: look for event-related schema names
  const candidates = [
    "event",
    "Event",
    "WebhookEvent",
    "webhook_event",
    "EventResponse",
    "Webhook",
  ];

  for (const candidate of candidates) {
    const schema = schemas[candidate];
    if (!schema) continue;

    const properties = extractSchemaProperties(spec, schema);
    if (Object.keys(properties).length > 0) {
      return {
        schema: { type: "object", properties },
        source: `schema:${candidate}`,
      };
    }
  }

  // Fallback: case-insensitive search
  for (const [name, schema] of Object.entries(schemas)) {
    if (
      /^(webhook_?)?event$/i.test(name) ||
      /^event_?(payload|data|body)$/i.test(name)
    ) {
      const properties = extractSchemaProperties(spec, schema);
      if (Object.keys(properties).length > 0) {
        return {
          schema: { type: "object", properties },
          source: `schema:${name}`,
        };
      }
    }
  }

  return null;
}

// ─── Trigger File Analysis ──────────────────────────────────────────────────

function findTriggerFiles(): string[] {
  const triggers: string[] = [];

  function walk(dir: string) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        walk(filePath);
      } else if (file.endsWith("Trigger.node.js") && !file.includes(".map")) {
        triggers.push(filePath);
      }
    }
  }

  walk(N8N_NODES_PATH);
  return triggers;
}

function getNodeType(filePath: string): string {
  const fileName = path.basename(filePath, ".node.js");
  const nodeName = fileName.charAt(0).toLowerCase() + fileName.slice(1);
  return `n8n-nodes-base.${nodeName}`;
}

function detectTriggerType(content: string): "webhook" | "polling" | "unknown" {
  const hasWebhook =
    /async\s+webhook\s*\(/.test(content) ||
    /webhook\s*\(\s*\)\s*{/.test(content);
  const hasPoll =
    /async\s+poll\s*\(/.test(content) || /poll\s*\(\s*\)\s*{/.test(content);

  if (hasWebhook) return "webhook";
  if (hasPoll) return "polling";
  return "unknown";
}

// ─── Transformation Detection ───────────────────────────────────────────────

interface TransformationResult {
  hasTransformation: boolean;
  functionName: string | null;
  fieldsRemoved: string[];
  fieldsAdded: Record<string, SchemaProperty>;
}

function detectTransformations(
  triggerPath: string,
  triggerCode: string,
): TransformationResult {
  const noTransform: TransformationResult = {
    hasTransformation: false,
    functionName: null,
    fieldsRemoved: [],
    fieldsAdded: {},
  };

  const transformPatterns = [/simplifyOutput/, /formatOutput/, /transformData/];

  let transformName: string | null = null;
  for (const pattern of transformPatterns) {
    if (pattern.test(triggerCode)) {
      transformName = pattern.source;
      break;
    }
  }

  if (!transformName) return noTransform;

  const dir = path.dirname(triggerPath);
  const genericPath = path.join(dir, "GenericFunctions.js");
  if (!fs.existsSync(genericPath)) return noTransform;

  const genericCode = fs.readFileSync(genericPath, "utf-8");
  const result: TransformationResult = {
    hasTransformation: true,
    functionName: transformName,
    fieldsRemoved: [],
    fieldsAdded: {},
  };

  // Detect field deletions: delete item.fieldName
  for (const match of genericCode.matchAll(/delete\s+item\.(\w+)/g)) {
    const field = match[1];
    if (!result.fieldsRemoved.includes(field)) {
      result.fieldsRemoved.push(field);
    }
  }

  // Detect field additions: item.fieldName = ...
  for (const match of genericCode.matchAll(/item\.(\w+)\s*=/g)) {
    const field = match[1];
    if (field !== "json" && !result.fieldsAdded[field]) {
      result.fieldsAdded[field] = { type: "unknown" };
    }
  }

  // Dynamic header extraction: item[header.name] = header.value
  // The actual headers are determined by metadataHeaders in the trigger code
  if (/item\[header\.name\]\s*=\s*header\.value/.test(genericCode)) {
    const metadataMatch = triggerCode.match(/metadataHeaders\s*=\s*\[(.*?)\]/s);
    if (metadataMatch) {
      const headers =
        metadataMatch[1]
          .match(/['"](\w+)['"]/g)
          ?.map((h) => h.replace(/['"]/g, "")) ?? [];
      for (const header of headers) {
        result.fieldsAdded[header] = { type: "string" };
      }
    }
  }

  // Labels transformation: item.labels = labels.filter(...)
  if (/item\.labels\s*=/.test(genericCode)) {
    result.fieldsAdded["labels"] = {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
    };
  }

  return result;
}

function applyTransformations(
  schema: TriggerOutputSchema,
  transformations: TransformationResult,
): TriggerOutputSchema {
  const result: TriggerOutputSchema = {
    type: "object",
    properties: { ...schema.properties },
  };

  for (const field of transformations.fieldsRemoved) {
    delete result.properties[field];
  }

  for (const [field, prop] of Object.entries(transformations.fieldsAdded)) {
    result.properties[field] = prop;
  }

  return result;
}

// ─── Main Crawler ───────────────────────────────────────────────────────────

async function crawlTriggers(): Promise<TriggerSchemaIndex> {
  console.log("Finding trigger files...");
  const triggerFiles = findTriggerFiles();
  console.log(`Found ${triggerFiles.length} triggers\n`);

  const guruIndex = await loadApisGuruIndex();

  const result: TriggerSchemaIndex = {
    version: "2.0.0",
    generatedAt: new Date().toISOString(),
    triggers: {},
    stats: {
      total: triggerFiles.length,
      withSchema: 0,
      withoutSchema: 0,
      webhook: 0,
      polling: 0,
      unknown: 0,
    },
  };

  for (const filePath of triggerFiles) {
    const nodeType = getNodeType(filePath);
    const triggerCode = fs.readFileSync(filePath, "utf-8");
    const triggerType = detectTriggerType(triggerCode);

    console.log(`${nodeType} (${triggerType})`);

    if (triggerType === "webhook") result.stats.webhook++;
    else if (triggerType === "polling") result.stats.polling++;
    else result.stats.unknown++;

    // Step 1: Extract API domains and endpoints from code
    const domains = extractApiDomains(filePath);
    const endpoints = extractApiEndpoints(filePath);

    // Step 2: Find APIs.guru key from domains
    let apisGuruKey: string | null = null;
    for (const domain of domains) {
      apisGuruKey = domainToApisGuruKey(domain, endpoints, guruIndex);
      if (apisGuruKey) break;
    }

    let outputSchema: TriggerOutputSchema | null = null;
    let openApiSource: string | null = null;
    let schemaSource: string | null = null;

    if (apisGuruKey) {
      const spec = await fetchOpenApiSpec(apisGuruKey);
      if (spec) {
        openApiSource = apisGuruKey;

        if (triggerType === "polling" && endpoints.length > 0) {
          // Polling: match endpoint path → response schema
          const pathResult = extractSchemaFromEndpoint(spec, endpoints);
          if (pathResult) {
            outputSchema = pathResult.schema;
            schemaSource = pathResult.source;
            console.log(
              `  -> ${pathResult.source} (${Object.keys(outputSchema.properties).length} fields)`,
            );
          }
        }

        if (!outputSchema && triggerType === "webhook") {
          // Webhook: find event/webhook schema
          const eventResult = extractEventSchema(spec);
          if (eventResult) {
            outputSchema = eventResult.schema;
            schemaSource = eventResult.source;
            console.log(
              `  -> ${eventResult.source} (${Object.keys(outputSchema.properties).length} fields)`,
            );
          }
        }

        if (!outputSchema) {
          console.log(`  -> No matching schema in ${apisGuruKey}`);
        }
      }
    } else if (domains.length > 0) {
      console.log(
        `  -> Domains found [${domains.slice(0, 3).join(", ")}] but no APIs.guru match`,
      );
    }

    // Step 3: Detect and apply transformations
    const transformations = detectTransformations(filePath, triggerCode);
    if (transformations.hasTransformation) {
      console.log(
        `  -> Transform: ${transformations.functionName} (-${transformations.fieldsRemoved.length} +${Object.keys(transformations.fieldsAdded).length})`,
      );

      if (outputSchema) {
        outputSchema = applyTransformations(outputSchema, transformations);
        console.log(
          `  -> After transform: ${Object.keys(outputSchema.properties).length} fields`,
        );
      }
    }

    const hasSchema = outputSchema !== null;
    if (hasSchema) result.stats.withSchema++;
    else result.stats.withoutSchema++;

    result.triggers[nodeType] = {
      triggerType,
      serviceName: apisGuruKey,
      openApiSource,
      schemaSource,
      hasTransformation: transformations.hasTransformation,
      transformationFunction: transformations.functionName,
      outputSchema,
      confidence: hasSchema ? "high" : "low",
      reason: hasSchema
        ? undefined
        : !apisGuruKey
          ? "No APIs.guru match"
          : "No schema found in spec",
    };
  }

  return result;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

crawlTriggers().then((result) => {
  console.log("\n══════════════════════════════════════");
  console.log(`Total: ${result.stats.total}`);
  console.log(`With schema: ${result.stats.withSchema}`);
  console.log(`Without schema: ${result.stats.withoutSchema}`);
  console.log(
    `Webhook: ${result.stats.webhook} | Polling: ${result.stats.polling} | Unknown: ${result.stats.unknown}`,
  );

  const outputPath = path.join(
    __dirname,
    "../src/data/triggerSchemaIndex.json",
  );
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`\nSaved to ${outputPath}`);

  const withSchema = Object.entries(result.triggers).filter(
    ([, v]) => v.outputSchema,
  );
  console.log(`\nTriggers with schemas (${withSchema.length}):`);
  for (const [name, entry] of withSchema) {
    const fieldCount = entry.outputSchema
      ? Object.keys(entry.outputSchema.properties).length
      : 0;
    const transform = entry.hasTransformation ? " [transformed]" : "";
    console.log(
      `  ${name}: ${fieldCount} fields via ${entry.schemaSource}${transform}`,
    );
  }
});
