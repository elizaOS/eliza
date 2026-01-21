#!/usr/bin/env node
/**
 * Action/Provider/Evaluator Docs Generator
 *
 * Reads canonical specs from packages/prompts/specs/** and generates
 * language-native docs modules for:
 * - packages/typescript
 * - packages/python
 * - packages/rust
 *
 * This is intentionally dependency-free (no zod/yup) to keep builds lightweight.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * @typedef {"string" | "number" | "boolean" | "object" | "array"} JsonSchemaType
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
  const t = schema.type;
  assertString(t, `${name}.type`);
  if (!["string", "number", "boolean", "object", "array"].includes(t)) {
    throw new Error(
      `${name}.type must be one of string|number|boolean|object|array`,
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
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {string} content
 * @returns {{ content: string, hashCount: number }}
 */
function escapeRustRawString(content) {
  let hashCount = 1;
  while (content.includes(`"${"#".repeat(hashCount)}`)) {
    hashCount++;
  }
  return { content, hashCount };
}

/**
 * Escape a string for use in Python triple-quoted string.
 * JSON won't normally contain `"""` but we escape defensively.
 * @param {string} content
 * @returns {string}
 */
function escapePythonTripleQuoted(content) {
  return content.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

function generateTypeScript(actionsSpec, providersSpec, evaluatorsSpec) {
  const outDir = path.join(
    REPO_ROOT,
    "packages",
    "typescript",
    "src",
    "generated",
  );
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

export type ActionDocParameterExampleValue = string | number | boolean | null;

export type ActionDocParameterSchema = {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  default?: ActionDocParameterExampleValue;
  enum?: string[];
  properties?: Record<string, ActionDocParameterSchema>;
  items?: ActionDocParameterSchema;
  minimum?: number;
  maximum?: number;
  pattern?: string;
};

export type ActionDocParameter = {
  name: string;
  description: string;
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
  similes?: readonly string[];
  parameters?: readonly ActionDocParameter[];
  examples?: readonly (readonly ActionDocExampleMessage[])[];
  exampleCalls?: readonly ActionDocExampleCall[];
};

export type ProviderDoc = {
  name: string;
  description: string;
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

  fs.writeFileSync(path.join(outDir, "action-docs.ts"), content);
}

function generatePython(actionsSpec, providersSpec, evaluatorsSpec) {
  const outDir = path.join(
    REPO_ROOT,
    "packages",
    "python",
    "elizaos",
    "generated",
  );
  ensureDir(outDir);

  const initPath = path.join(outDir, "__init__.py");
  if (!fs.existsSync(initPath)) {
    fs.writeFileSync(initPath, '"""Auto-generated module package."""\n');
  }

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

  const content = `"""
Auto-generated canonical action/provider/evaluator docs.
DO NOT EDIT - Generated from packages/prompts/specs/**.
"""

from __future__ import annotations

import json

from typing import Literal, TypedDict


JsonSchemaType = Literal["string", "number", "boolean", "object", "array"]
ActionDocParameterExampleValue = str | int | float | bool | None


class ActionDocParameterSchema(TypedDict, total=False):
    type: JsonSchemaType
    description: str
    default: ActionDocParameterExampleValue
    enum: list[str]
    properties: dict[str, "ActionDocParameterSchema"]
    items: "ActionDocParameterSchema"
    minimum: float
    maximum: float
    pattern: str


class ActionDocParameter(TypedDict, total=False):
    name: str
    description: str
    required: bool
    schema: ActionDocParameterSchema
    examples: list[ActionDocParameterExampleValue]


class ActionDocExampleCall(TypedDict, total=False):
    user: str
    actions: list[str]
    params: dict[str, dict[str, ActionDocParameterExampleValue]]


class ActionDocExampleMessage(TypedDict, total=False):
    name: str
    content: dict[str, object]


class ActionDoc(TypedDict, total=False):
    name: str
    description: str
    similes: list[str]
    parameters: list[ActionDocParameter]
    examples: list[list[ActionDocExampleMessage]]
    exampleCalls: list[ActionDocExampleCall]


class ProviderDoc(TypedDict, total=False):
    name: str
    description: str
    position: int
    dynamic: bool


class EvaluatorDocMessageContent(TypedDict, total=False):
    text: str
    type: str


class EvaluatorDocMessage(TypedDict):
    name: str
    content: EvaluatorDocMessageContent


class EvaluatorDocExample(TypedDict):
    prompt: str
    messages: list[EvaluatorDocMessage]
    outcome: str


class EvaluatorDoc(TypedDict, total=False):
    name: str
    description: str
    similes: list[str]
    alwaysRun: bool
    examples: list[EvaluatorDocExample]


core_actions_spec_version: str = ${JSON.stringify(actionsSpec.core.version)}
all_actions_spec_version: str = ${JSON.stringify(actionsSpec.all.version)}
core_providers_spec_version: str = ${JSON.stringify(providersSpec.core.version)}
all_providers_spec_version: str = ${JSON.stringify(providersSpec.all.version)}
core_evaluators_spec_version: str = ${JSON.stringify(evaluatorsSpec.core.version)}
all_evaluators_spec_version: str = ${JSON.stringify(evaluatorsSpec.all.version)}

_CORE_ACTION_DOCS_JSON = """${escapePythonTripleQuoted(actionsJson)}"""
_ALL_ACTION_DOCS_JSON = """${escapePythonTripleQuoted(actionsAllJson)}"""
_CORE_PROVIDER_DOCS_JSON = """${escapePythonTripleQuoted(providersJson)}"""
_ALL_PROVIDER_DOCS_JSON = """${escapePythonTripleQuoted(providersAllJson)}"""
_CORE_EVALUATOR_DOCS_JSON = """${escapePythonTripleQuoted(evaluatorsJson)}"""
_ALL_EVALUATOR_DOCS_JSON = """${escapePythonTripleQuoted(evaluatorsAllJson)}"""

core_action_docs: dict[str, object] = json.loads(_CORE_ACTION_DOCS_JSON)
all_action_docs: dict[str, object] = json.loads(_ALL_ACTION_DOCS_JSON)
core_provider_docs: dict[str, object] = json.loads(_CORE_PROVIDER_DOCS_JSON)
all_provider_docs: dict[str, object] = json.loads(_ALL_PROVIDER_DOCS_JSON)
core_evaluator_docs: dict[str, object] = json.loads(_CORE_EVALUATOR_DOCS_JSON)
all_evaluator_docs: dict[str, object] = json.loads(_ALL_EVALUATOR_DOCS_JSON)

__all__ = [
    "ActionDoc",
    "ActionDocExampleCall",
    "ActionDocExampleMessage",
    "ActionDocParameter",
    "ActionDocParameterSchema",
    "ActionDocParameterExampleValue",
    "ProviderDoc",
    "EvaluatorDoc",
    "EvaluatorDocExample",
    "EvaluatorDocMessage",
    "EvaluatorDocMessageContent",
    "core_actions_spec_version",
    "all_actions_spec_version",
    "core_providers_spec_version",
    "all_providers_spec_version",
    "core_evaluators_spec_version",
    "all_evaluators_spec_version",
    "core_action_docs",
    "all_action_docs",
    "core_provider_docs",
    "all_provider_docs",
    "core_evaluator_docs",
    "all_evaluator_docs",
]
`;

  fs.writeFileSync(path.join(outDir, "action_docs.py"), content);
}

function generateRust(actionsSpec, providersSpec, evaluatorsSpec) {
  const outDir = path.join(REPO_ROOT, "packages", "rust", "src", "generated");
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

  const { content: actionsContent, hashCount: actionsHashCount } =
    escapeRustRawString(actionsJson);
  const { content: actionsAllContent, hashCount: actionsAllHashCount } =
    escapeRustRawString(actionsAllJson);
  const { content: providersContent, hashCount: providersHashCount } =
    escapeRustRawString(providersJson);
  const { content: providersAllContent, hashCount: providersAllHashCount } =
    escapeRustRawString(providersAllJson);
  const { content: evalContent, hashCount: evalHashCount } =
    escapeRustRawString(evaluatorsJson);
  const { content: evalAllContent, hashCount: evalAllHashCount } =
    escapeRustRawString(evaluatorsAllJson);

  const actionsDelim = "#".repeat(actionsHashCount);
  const actionsAllDelim = "#".repeat(actionsAllHashCount);
  const providersDelim = "#".repeat(providersHashCount);
  const providersAllDelim = "#".repeat(providersAllHashCount);
  const evalDelim = "#".repeat(evalHashCount);
  const evalAllDelim = "#".repeat(evalAllHashCount);

  const content = `//! Auto-generated canonical action/provider/evaluator docs.
//! DO NOT EDIT - Generated from packages/prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r${actionsDelim}"${actionsContent}"${actionsDelim};
pub const ALL_ACTION_DOCS_JSON: &str = r${actionsAllDelim}"${actionsAllContent}"${actionsAllDelim};
pub const CORE_PROVIDER_DOCS_JSON: &str = r${providersDelim}"${providersContent}"${providersDelim};
pub const ALL_PROVIDER_DOCS_JSON: &str = r${providersAllDelim}"${providersAllContent}"${providersAllDelim};
pub const CORE_EVALUATOR_DOCS_JSON: &str = r${evalDelim}"${evalContent}"${evalDelim};
pub const ALL_EVALUATOR_DOCS_JSON: &str = r${evalAllDelim}"${evalAllContent}"${evalAllDelim};
`;

  fs.writeFileSync(path.join(outDir, "action_docs.rs"), content);

  const modPath = path.join(outDir, "mod.rs");
  const modContent = `//! Auto-generated docs module.\n\npub mod action_docs;\n`;
  fs.writeFileSync(modPath, modContent);
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

  generateTypeScript(actionsSpec, providersSpec, evaluatorsSpec);
  generatePython(actionsSpec, providersSpec, evaluatorsSpec);
  generateRust(actionsSpec, providersSpec, evaluatorsSpec);

  console.log("Generated action/provider/evaluator docs.");
}

main();
