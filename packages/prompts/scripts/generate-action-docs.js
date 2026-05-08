#!/usr/bin/env node
/**
 * Action/Provider/Evaluator Docs Generator
 *
 * Reads canonical specs from packages/prompts/specs/** and generates
 * TypeScript docs modules under packages/core/src/generated.
 *
 * This is intentionally dependency-free (no zod/yup) to keep builds lightweight.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compressPromptDescription } from "./prompt-compression.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PROMPTS_ROOT = path.resolve(__dirname, "..");

const ACTIONS_SPECS_DIR = path.join(PROMPTS_ROOT, "specs", "actions");
const PROVIDERS_SPECS_DIR = path.join(PROMPTS_ROOT, "specs", "providers");
const EVALUATORS_SPECS_DIR = path.join(PROMPTS_ROOT, "specs", "evaluators");

const CORE_ACTIONS_SPEC_PATH = path.join(ACTIONS_SPECS_DIR, "core.json");
const CORE_PROVIDERS_SPEC_PATH = path.join(PROVIDERS_SPECS_DIR, "core.json");
const CORE_EVALUATORS_SPEC_PATH = path.join(EVALUATORS_SPECS_DIR, "core.json");

/**
 * @typedef {"string" | "number" | "integer" | "boolean" | "object" | "array"} JsonSchemaType
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is Record<string, unknown>}
 */
function assertRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is string}
 */
function assertString(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} name
 */
function assertCompressedDescriptionAliases(value, name) {
  if (value.descriptionCompressed !== undefined) {
    assertString(value.descriptionCompressed, `${name}.descriptionCompressed`);
  }
  if (value.compressedDescription !== undefined) {
    assertString(value.compressedDescription, `${name}.compressedDescription`);
  }
  if (
    typeof value.descriptionCompressed === "string" &&
    typeof value.compressedDescription === "string" &&
    value.descriptionCompressed !== value.compressedDescription
  ) {
    throw new Error(
      `${name}.descriptionCompressed and ${name}.compressedDescription must match when both are provided`,
    );
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is boolean}
 */
function assertBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is unknown[]}
 */
function assertArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is (string | number | boolean | null)[]}
 */
function assertExampleValuesArray(value, name) {
  assertArray(value, name);
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    const t = typeof v;
    if (v !== null && t !== "string" && t !== "number" && t !== "boolean") {
      throw new Error(
        `${name}[${i}] must be string | number | boolean | null (got ${t})`,
      );
    }
  }
}

/**
 * @param {unknown} schema
 * @param {string} name
 * @returns {asserts schema is Record<string, unknown> & { type: JsonSchemaType }}
 */
function assertParameterSchema(schema, name) {
  assertRecord(schema, name);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    for (let i = 0; i < schema.oneOf.length; i++) {
      assertParameterSchema(schema.oneOf[i], `${name}.oneOf[${i}]`);
    }
    return;
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    for (let i = 0; i < schema.anyOf.length; i++) {
      assertParameterSchema(schema.anyOf[i], `${name}.anyOf[${i}]`);
    }
    return;
  }
  const t = schema.type;
  assertString(t, `${name}.type`);
  if (
    !["string", "number", "integer", "boolean", "object", "array"].includes(t)
  ) {
    throw new Error(
      `${name}.type must be one of string|number|integer|boolean|object|array`,
    );
  }
  if (schema.enum !== undefined) {
    assertArray(schema.enum, `${name}.enum`);
    for (let i = 0; i < schema.enum.length; i++) {
      assertString(schema.enum[i], `${name}.enum[${i}]`);
    }
  }
  if (schema.default !== undefined) {
    const dv = schema.default;
    const dt = typeof dv;
    if (dv !== null && dt !== "string" && dt !== "number" && dt !== "boolean") {
      throw new Error(
        `${name}.default must be string|number|boolean|null if provided`,
      );
    }
  }
  if (schema.minimum !== undefined && typeof schema.minimum !== "number") {
    throw new Error(`${name}.minimum must be a number if provided`);
  }
  if (schema.maximum !== undefined && typeof schema.maximum !== "number") {
    throw new Error(`${name}.maximum must be a number if provided`);
  }
  if (schema.pattern !== undefined) {
    assertString(schema.pattern, `${name}.pattern`);
  }
}

/**
 * @param {unknown} param
 * @param {string} name
 * @returns {asserts param is Record<string, unknown>}
 */
function assertActionParameter(param, name) {
  assertRecord(param, name);
  assertString(param.name, `${name}.name`);
  assertString(param.description, `${name}.description`);
  assertCompressedDescriptionAliases(param, name);
  if (param.required !== undefined) {
    assertBoolean(param.required, `${name}.required`);
  }
  assertParameterSchema(param.schema, `${name}.schema`);
  if (param.examples !== undefined) {
    assertExampleValuesArray(param.examples, `${name}.examples`);
  }
}

/**
 * @param {unknown} action
 * @param {string} name
 * @returns {asserts action is Record<string, unknown>}
 */
function assertActionDoc(action, name) {
  assertRecord(action, name);
  assertString(action.name, `${name}.name`);
  assertString(action.description, `${name}.description`);
  assertCompressedDescriptionAliases(action, name);
  if (action.similes !== undefined) {
    assertArray(action.similes, `${name}.similes`);
    for (let i = 0; i < action.similes.length; i++) {
      assertString(action.similes[i], `${name}.similes[${i}]`);
    }
  }
  if (action.parameters !== undefined) {
    assertArray(action.parameters, `${name}.parameters`);
    for (let i = 0; i < action.parameters.length; i++) {
      assertActionParameter(action.parameters[i], `${name}.parameters[${i}]`);
    }
  }
  if (action.examples !== undefined) {
    assertArray(action.examples, `${name}.examples`);
  }
  if (action.exampleCalls !== undefined) {
    assertArray(action.exampleCalls, `${name}.exampleCalls`);
  }
}

/**
 * @param {unknown} provider
 * @param {string} name
 * @returns {asserts provider is Record<string, unknown>}
 */
function assertProviderDoc(provider, name) {
  assertRecord(provider, name);
  assertString(provider.name, `${name}.name`);
  assertString(provider.description, `${name}.description`);
  assertCompressedDescriptionAliases(provider, name);
  if (
    provider.position !== undefined &&
    typeof provider.position !== "number"
  ) {
    throw new Error(`${name}.position must be a number if provided`);
  }
  if (provider.dynamic !== undefined) {
    assertBoolean(provider.dynamic, `${name}.dynamic`);
  }
}

/**
 * @param {unknown} evaluator
 * @param {string} name
 * @returns {asserts evaluator is Record<string, unknown>}
 */
function assertEvaluatorDoc(evaluator, name) {
  assertRecord(evaluator, name);
  assertString(evaluator.name, `${name}.name`);
  assertString(evaluator.description, `${name}.description`);
  assertCompressedDescriptionAliases(evaluator, name);
  if (evaluator.similes !== undefined) {
    assertArray(evaluator.similes, `${name}.similes`);
    for (let i = 0; i < evaluator.similes.length; i++) {
      assertString(evaluator.similes[i], `${name}.similes[${i}]`);
    }
  }
  if (evaluator.alwaysRun !== undefined) {
    assertBoolean(evaluator.alwaysRun, `${name}.alwaysRun`);
  }
  if (evaluator.examples !== undefined) {
    assertArray(evaluator.examples, `${name}.examples`);
  }
}

/**
 * @param {string} filePath
 * @returns {unknown}
 */
function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Recursively list .json files in a directory.
 * @param {string} rootDir
 * @returns {string[]}
 */
function listJsonFiles(rootDir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(rootDir)) {
    return out;
  }
  /** @type {string[]} */
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * @param {unknown} root
 * @param {string} label
 * @returns {{ version: string, actions: unknown[] }}
 */
function parseActionsSpec(root, label) {
  assertRecord(root, label);
  assertString(root.version, `${label}.version`);
  assertArray(root.actions, `${label}.actions`);
  for (let i = 0; i < root.actions.length; i++) {
    assertActionDoc(root.actions[i], `${label}.actions[${i}]`);
  }
  return { version: root.version, actions: root.actions };
}

/**
 * @param {unknown} root
 * @param {string} label
 * @returns {{ version: string, providers: unknown[] }}
 */
function parseProvidersSpec(root, label) {
  assertRecord(root, label);
  assertString(root.version, `${label}.version`);
  assertArray(root.providers, `${label}.providers`);
  for (let i = 0; i < root.providers.length; i++) {
    assertProviderDoc(root.providers[i], `${label}.providers[${i}]`);
  }
  return { version: root.version, providers: root.providers };
}

/**
 * @param {unknown} root
 * @param {string} label
 * @returns {{ version: string, evaluators: unknown[] }}
 */
function parseEvaluatorsSpec(root, label) {
  assertRecord(root, label);
  assertString(root.version, `${label}.version`);
  assertArray(root.evaluators, `${label}.evaluators`);
  for (let i = 0; i < root.evaluators.length; i++) {
    assertEvaluatorDoc(root.evaluators[i], `${label}.evaluators[${i}]`);
  }
  return { version: root.version, evaluators: root.evaluators };
}

/**
 * @param {unknown[]} docs
 * @param {string} label
 */
function assertUniqueNames(docs, label) {
  /** @type {Set<string>} */
  const seen = new Set();
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    assertRecord(d, `${label}[${i}]`);
    assertString(d.name, `${label}[${i}].name`);
    const name = d.name;
    if (seen.has(name)) {
      throw new Error(`${label} contains duplicate name: ${name}`);
    }
    seen.add(name);
  }
}

/**
 * @param {string} dir
 * @param {string} corePath
 * @param {"actions" | "providers" | "evaluators"} kind
 * @returns {{ core: { version: string, items: unknown[] }, all: { version: string, items: unknown[] } }}
 */
function loadSpecs(dir, corePath, kind) {
  if (!fs.existsSync(corePath)) {
    return {
      core: { version: "1.0.0", items: [] },
      all: { version: "1.0.0", items: [] },
    };
  }

  const coreRoot = readJson(corePath);
  const coreLabel = `${kind} core spec`;
  let coreParsed;

  if (kind === "actions") {
    coreParsed = parseActionsSpec(coreRoot, coreLabel);
  } else if (kind === "providers") {
    coreParsed = parseProvidersSpec(coreRoot, coreLabel);
  } else {
    coreParsed = parseEvaluatorsSpec(coreRoot, coreLabel);
  }

  const allFiles = listJsonFiles(dir).filter(
    (p) => path.resolve(p) !== path.resolve(corePath),
  );
  /** @type {unknown[]} */
  const merged = [
    ...(kind === "actions"
      ? coreParsed.actions
      : kind === "providers"
        ? coreParsed.providers
        : coreParsed.evaluators),
  ];

  for (const filePath of allFiles) {
    const root = readJson(filePath);
    const label = `${kind} spec (${path.relative(PROMPTS_ROOT, filePath)})`;
    let parsed;

    if (kind === "actions") {
      parsed = parseActionsSpec(root, label);
    } else if (kind === "providers") {
      parsed = parseProvidersSpec(root, label);
    } else {
      parsed = parseEvaluatorsSpec(root, label);
    }

    if (parsed.version !== coreParsed.version) {
      throw new Error(
        `${label}.version (${parsed.version}) must match core version (${coreParsed.version})`,
      );
    }
    merged.push(
      ...(kind === "actions"
        ? parsed.actions
        : kind === "providers"
          ? parsed.providers
          : parsed.evaluators),
    );
  }

  const itemsLabel =
    kind === "actions"
      ? "actions spec.actions"
      : kind === "providers"
        ? "providers spec.providers"
        : "evaluators spec.evaluators";
  assertUniqueNames(merged, itemsLabel);

  return {
    core: {
      version: coreParsed.version,
      items:
        kind === "actions"
          ? coreParsed.actions
          : kind === "providers"
            ? coreParsed.providers
            : coreParsed.evaluators,
    },
    all: {
      version: coreParsed.version,
      items: merged,
    },
  };
}

/**
 * Ensures a directory exists, creating it and parent directories if necessary.
 * @param {string} dir - The directory path to ensure exists
 * @throws {Error} If the directory path is empty or whitespace-only
 */
function ensureDir(dir) {
  if (!dir || dir.trim() === "") {
    throw new Error("Directory path cannot be empty");
  }
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {Record<string, unknown>} doc
 * @returns {string | undefined}
 */
function getCompressedAlias(doc) {
  const canonical = doc.descriptionCompressed;
  if (typeof canonical === "string" && canonical.trim()) {
    return canonical;
  }
  const alias = doc.compressedDescription;
  if (typeof alias === "string" && alias.trim()) {
    return alias;
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} doc
 */
function normalizeCompressedDescription(doc) {
  if (typeof doc.description !== "string") {
    return;
  }
  doc.descriptionCompressed =
    getCompressedAlias(doc) ?? compressPromptDescription(doc.description);
}

/**
 * @param {Record<string, unknown>} action
 */
function normalizeActionDoc(action) {
  normalizeCompressedDescription(action);
  if (!Array.isArray(action.parameters)) {
    return;
  }
  for (const p of action.parameters) {
    if (!p || typeof p !== "object") {
      continue;
    }
    const param = /** @type {Record<string, unknown>} */ (p);
    if (typeof param.description !== "string") {
      continue;
    }
    normalizeCompressedDescription(param);
  }
}

/**
 * @param {Record<string, unknown>} provider
 */
function normalizeProviderDoc(provider) {
  normalizeCompressedDescription(provider);
}

/**
 * @param {Record<string, unknown>} evaluator
 */
function normalizeEvaluatorDoc(evaluator) {
  normalizeCompressedDescription(evaluator);
}

/**
 * @param {{ core: { items: unknown[] }; all: { items: unknown[] } }} actionsSpec
 * @param {{ core: { items: unknown[] }; all: { items: unknown[] } }} providersSpec
 * @param {{ core: { items: unknown[] }; all: { items: unknown[] } }} evaluatorsSpec
 */
function normalizeSpecsInPlace(actionsSpec, providersSpec, evaluatorsSpec) {
  for (const action of actionsSpec.core.items) {
    normalizeActionDoc(/** @type {Record<string, unknown>} */ (action));
  }
  for (const action of actionsSpec.all.items) {
    normalizeActionDoc(/** @type {Record<string, unknown>} */ (action));
  }
  for (const p of providersSpec.core.items) {
    normalizeProviderDoc(/** @type {Record<string, unknown>} */ (p));
  }
  for (const p of providersSpec.all.items) {
    normalizeProviderDoc(/** @type {Record<string, unknown>} */ (p));
  }
  for (const evaluator of evaluatorsSpec.core.items) {
    normalizeEvaluatorDoc(/** @type {Record<string, unknown>} */ (evaluator));
  }
  for (const evaluator of evaluatorsSpec.all.items) {
    normalizeEvaluatorDoc(/** @type {Record<string, unknown>} */ (evaluator));
  }
}

function generateTypeScript(actionsSpec, providersSpec, evaluatorsSpec) {
  const outDir = path.join(REPO_ROOT, "packages", "core", "src", "generated");
  ensureDir(outDir);

  const actionsJson = JSON.stringify(
    { version: actionsSpec.core.version, actions: actionsSpec.core.items },
    null,
    2,
  );
  const actionsAllJson = JSON.stringify(
    { version: actionsSpec.all.version, actions: actionsSpec.all.items },
    null,
    2,
  );
  const providersJson = JSON.stringify(
    {
      version: providersSpec.core.version,
      providers: providersSpec.core.items,
    },
    null,
    2,
  );
  const providersAllJson = JSON.stringify(
    { version: providersSpec.all.version, providers: providersSpec.all.items },
    null,
    2,
  );
  const evaluatorsJson = JSON.stringify(
    {
      version: evaluatorsSpec.core.version,
      evaluators: evaluatorsSpec.core.items,
    },
    null,
    2,
  );
  const evaluatorsAllJson = JSON.stringify(
    {
      version: evaluatorsSpec.all.version,
      evaluators: evaluatorsSpec.all.items,
    },
    null,
    2,
  );

  const content = `/**
 * Auto-generated canonical action/provider/evaluator docs.
 * DO NOT EDIT - Generated from packages/prompts/specs/**.
 */

export type ActionDocParameterExampleValue =
  | string
  | number
  | boolean
  | null
  | readonly ActionDocParameterExampleValue[]
  | { readonly [key: string]: ActionDocParameterExampleValue };

export type ActionDocParameterSchema = {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  default?: ActionDocParameterExampleValue;
  enum?: string[];
  properties?: Record<string, ActionDocParameterSchema>;
  items?: ActionDocParameterSchema;
  oneOf?: ActionDocParameterSchema[];
  anyOf?: ActionDocParameterSchema[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
};

export type ActionDocParameter = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  compressedDescription?: string;
  required?: boolean;
  schema: ActionDocParameterSchema;
  examples?: readonly ActionDocParameterExampleValue[];
};

export type ActionDocExampleCall = {
  user: string;
  actions: readonly string[];
  params?: Record<string, Record<string, ActionDocParameterExampleValue>>;
};

export type ActionDocExampleMessage = {
  name: string;
  content: {
    text: string;
    actions?: readonly string[];
  };
};

export type ActionDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  compressedDescription?: string;
  similes?: readonly string[];
  parameters?: readonly ActionDocParameter[];
  examples?: readonly (readonly ActionDocExampleMessage[])[];
  exampleCalls?: readonly ActionDocExampleCall[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  compressedDescription?: string;
  position?: number;
  dynamic?: boolean;
};

export type EvaluatorDocMessageContent = {
  text: string;
  type?: string;
};

export type EvaluatorDocMessage = {
  name: string;
  content: EvaluatorDocMessageContent;
};

export type EvaluatorDocExample = {
  prompt: string;
  messages: readonly EvaluatorDocMessage[];
  outcome: string;
};

export type EvaluatorDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  compressedDescription?: string;
  similes?: readonly string[];
  alwaysRun?: boolean;
  examples?: readonly EvaluatorDocExample[];
};

export const coreActionsSpecVersion = ${JSON.stringify(actionsSpec.core.version)} as const;
export const allActionsSpecVersion = ${JSON.stringify(actionsSpec.all.version)} as const;
export const coreProvidersSpecVersion = ${JSON.stringify(providersSpec.core.version)} as const;
export const allProvidersSpecVersion = ${JSON.stringify(providersSpec.all.version)} as const;
export const coreEvaluatorsSpecVersion = ${JSON.stringify(evaluatorsSpec.core.version)} as const;
export const allEvaluatorsSpecVersion = ${JSON.stringify(evaluatorsSpec.all.version)} as const;

export const coreActionsSpec = ${actionsJson} as const satisfies { version: string; actions: readonly ActionDoc[] };
export const allActionsSpec = ${actionsAllJson} as const satisfies { version: string; actions: readonly ActionDoc[] };
export const coreProvidersSpec = ${providersJson} as const satisfies { version: string; providers: readonly ProviderDoc[] };
export const allProvidersSpec = ${providersAllJson} as const satisfies { version: string; providers: readonly ProviderDoc[] };
export const coreEvaluatorsSpec = ${evaluatorsJson} as const satisfies {
  version: string;
  evaluators: readonly EvaluatorDoc[];
};
export const allEvaluatorsSpec = ${evaluatorsAllJson} as const satisfies {
  version: string;
  evaluators: readonly EvaluatorDoc[];
};

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
export const coreEvaluatorDocs: readonly EvaluatorDoc[] = coreEvaluatorsSpec.evaluators;
export const allEvaluatorDocs: readonly EvaluatorDoc[] = allEvaluatorsSpec.evaluators;
`;

  const actionDocsPath = path.join(outDir, "action-docs.ts");
  fs.writeFileSync(actionDocsPath, content);
  try {
    execFileSync(
      "bunx",
      ["@biomejs/biome", "check", "--write", actionDocsPath],
      { cwd: REPO_ROOT, stdio: "pipe" },
    );
  } catch {
    // Biome may be unavailable in stripped-down environments.
  }
}

function main() {
  const actionsSpec = loadSpecs(
    ACTIONS_SPECS_DIR,
    CORE_ACTIONS_SPEC_PATH,
    "actions",
  );
  const providersSpec = loadSpecs(
    PROVIDERS_SPECS_DIR,
    CORE_PROVIDERS_SPEC_PATH,
    "providers",
  );
  const evaluatorsSpec = loadSpecs(
    EVALUATORS_SPECS_DIR,
    CORE_EVALUATORS_SPEC_PATH,
    "evaluators",
  );

  normalizeSpecsInPlace(actionsSpec, providersSpec, evaluatorsSpec);

  generateTypeScript(actionsSpec, providersSpec, evaluatorsSpec);

  console.log("Generated action/provider/evaluator docs.");
}

main();
