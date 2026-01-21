import { names, uniqueNamesGenerator } from "unique-names-generator";
import { allActionDocs } from "./generated/action-docs.ts";
import type {
  Action,
  ActionExample,
  ActionParameter,
  ActionParameterSchema,
  ActionParameters,
  ActionParameterValue,
  JsonValue,
} from "./types";

type ActionDocByName = Record<string, (typeof allActionDocs)[number]>;

const actionDocByName: ActionDocByName = allActionDocs.reduce<ActionDocByName>(
  (acc, doc) => {
    acc[doc.name] = doc;
    return acc;
  },
  {},
);

export const composeActionExamples = (
  actionsData: Action[],
  count: number,
): string => {
  if (!actionsData.length || count <= 0) {
    return "";
  }

  const actionsWithExamples = actionsData.filter(
    (action) =>
      action.examples &&
      Array.isArray(action.examples) &&
      action.examples.length > 0,
  );

  if (!actionsWithExamples.length) {
    return "";
  }

  const examplesCopy: ActionExample[][][] = actionsWithExamples.map(
    (action) => [...(action.examples || [])],
  );

  const selectedExamples: ActionExample[][] = [];

  const availableActionIndices = examplesCopy
    .map((examples, index) => (examples.length > 0 ? index : -1))
    .filter((index) => index !== -1);

  while (selectedExamples.length < count && availableActionIndices.length > 0) {
    const randomIndex = Math.floor(
      Math.random() * availableActionIndices.length,
    );
    const actionIndex = availableActionIndices[randomIndex];
    const examples = examplesCopy[actionIndex];

    const exampleIndex = Math.floor(Math.random() * examples.length);
    selectedExamples.push(examples.splice(exampleIndex, 1)[0]);

    if (examples.length === 0) {
      availableActionIndices.splice(randomIndex, 1);
    }
  }

  return formatSelectedExamples(selectedExamples);
};

function escapeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatActionCallExample(example: {
  user: string;
  actions: readonly string[];
  params?: Record<string, Record<string, string | number | boolean | null>>;
}): string {
  const actionTags = example.actions
    .map((a) => `  <action>${escapeXmlText(a)}</action>`)
    .join("\n");

  const paramsByAction = example.params ?? {};
  const paramsBlocks = Object.entries(paramsByAction)
    .map(([actionName, params]) => {
      const inner = Object.entries(params)
        .map(([k, v]) => {
          const raw =
            typeof v === "string" ? v : v === null ? "null" : JSON.stringify(v);
          return `    <${k}>${escapeXmlText(raw)}</${k}>`;
        })
        .join("\n");
      return `  <${actionName}>\n${inner}\n  </${actionName}>`;
    })
    .join("\n");

  const paramsSection =
    paramsBlocks.length > 0 ? `\n<params>\n${paramsBlocks}\n</params>` : "";

  return `User: ${example.user}\nAssistant:\n<actions>\n${actionTags}\n</actions>${paramsSection}`;
}

/**
 * Render canonical action-call examples (including <params> blocks).
 *
 * Deterministic ordering is important to keep tests stable and avoid prompt churn.
 */
export function composeActionCallExamples(
  actionsData: Action[],
  maxExamples: number,
): string {
  if (!actionsData.length || maxExamples <= 0) return "";

  const blocks: string[] = [];
  const sorted = [...actionsData].sort((a, b) => a.name.localeCompare(b.name));

  for (const action of sorted) {
    const doc = actionDocByName[action.name];
    if (!doc?.exampleCalls || doc.exampleCalls.length === 0) continue;
    for (const ex of doc.exampleCalls) {
      blocks.push(formatActionCallExample(ex));
      if (blocks.length >= maxExamples) return blocks.join("\n\n");
    }
  }

  return blocks.join("\n\n");
}

const formatSelectedExamples = (examples: ActionExample[][]): string => {
  const MAX_NAME_PLACEHOLDERS = 5;

  return examples
    .map((example) => {
      const randomNames = Array.from({ length: MAX_NAME_PLACEHOLDERS }, () =>
        uniqueNamesGenerator({ dictionaries: [names] }),
      );

      const conversation = example
        .map((message) => {
          let messageText = `${message.name}: ${message.content.text}`;

          for (let i = 0; i < randomNames.length; i++) {
            messageText = messageText.replaceAll(
              `{{name${i + 1}}}`,
              randomNames[i],
            );
          }

          return messageText;
        })
        .join("\n");

      return `\n${conversation}`;
    })
    .join("\n");
};

function shuffleActions<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function formatActionNames(actions: Action[]): string {
  if (!actions || !actions.length) return "";

  return shuffleActions(actions)
    .map((action) => action.name)
    .join(", ");
}

export function formatActions(actions: Action[]): string {
  if (!actions || !actions.length) return "";

  return shuffleActions(actions)
    .map((action) => {
      let actionText = `- **${action.name}**: ${action.description || "No description available"}`;

      if (action.parameters && action.parameters.length > 0) {
        const paramsText = formatActionParameters(action.parameters);
        actionText += `\n  Parameters:\n${paramsText}`;
      }

      return actionText;
    })
    .join("\n");
}

export function formatActionParameters(parameters: ActionParameter[]): string {
  if (!parameters || !parameters.length) return "";

  return parameters
    .map((param) => {
      const requiredStr = param.required ? " (required)" : " (optional)";
      const typeStr = formatParameterType(param.schema);
      const defaultStr =
        param.schema.default !== undefined
          ? ` [default: ${JSON.stringify(param.schema.default)}]`
          : "";
      const enumStr = param.schema.enum
        ? ` [values: ${param.schema.enum.join(", ")}]`
        : "";
      const examplesStr =
        param.examples && param.examples.length > 0
          ? ` [examples: ${param.examples.map((v) => JSON.stringify(v)).join(", ")}]`
          : "";

      return `    - ${param.name}${requiredStr}: ${param.description} (${typeStr}${enumStr}${defaultStr}${examplesStr})`;
    })
    .join("\n");
}

function formatParameterType(schema: ActionParameterSchema): string {
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
      return schema.minimum !== undefined || schema.maximum !== undefined
        ? `number [${schema.minimum ?? "∞"}-${schema.maximum ?? "∞"}]`
        : "number";
    case "boolean":
      return "boolean";
    case "array":
      return schema.items
        ? `array of ${formatParameterType(schema.items)}`
        : "array";
    case "object":
      return "object";
    default:
      return schema.type;
  }
}

export function parseActionParams(
  paramsXml: string | undefined | null,
): Map<string, ActionParameters> {
  const result = new Map<string, ActionParameters>();

  if (!paramsXml || typeof paramsXml !== "string") {
    return result;
  }

  const actionBlocks = extractXmlChildren(paramsXml);

  for (const { key: actionName, value: actionParamsXml } of actionBlocks) {
    const params = extractXmlChildren(actionParamsXml);
    const actionParams: ActionParameters = {};

    for (const { key: paramName, value: paramValue } of params) {
      actionParams[paramName] = parseParamValue(paramValue);
    }

    if (Object.keys(actionParams).length > 0) {
      result.set(actionName.toUpperCase(), actionParams);
    }
  }

  return result;
}

function extractXmlChildren(
  xml: string,
): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  const length = xml.length;
  let i = 0;

  while (i < length) {
    const openIdx = xml.indexOf("<", i);
    if (openIdx === -1) break;

    if (
      xml.startsWith("</", openIdx) ||
      xml.startsWith("<!--", openIdx) ||
      xml.startsWith("<?", openIdx)
    ) {
      i = openIdx + 1;
      continue;
    }

    let j = openIdx + 1;
    let tag = "";
    while (j < length) {
      const ch = xml[j];
      if (/^[A-Za-z0-9_-]$/.test(ch)) {
        tag += ch;
        j++;
        continue;
      }
      break;
    }
    if (!tag) {
      i = openIdx + 1;
      continue;
    }

    const startTagEnd = xml.indexOf(">", j);
    if (startTagEnd === -1) break;

    const startTagText = xml.slice(openIdx, startTagEnd + 1);
    if (/\/\s*>$/.test(startTagText)) {
      i = startTagEnd + 1;
      continue;
    }

    const closeSeq = `</${tag}>`;
    let depth = 1;
    let searchStart = startTagEnd + 1;
    while (depth > 0 && searchStart < length) {
      const nextOpen = xml.indexOf(`<${tag}`, searchStart);
      const nextClose = xml.indexOf(closeSeq, searchStart);
      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        const nestedStartEnd = xml.indexOf(">", nextOpen + 1);
        if (nestedStartEnd === -1) break;
        const nestedStartText = xml.slice(nextOpen, nestedStartEnd + 1);
        if (!/\/\s*>$/.test(nestedStartText)) {
          depth++;
        }
        searchStart = nestedStartEnd + 1;
      } else {
        depth--;
        searchStart = nextClose + closeSeq.length;
      }
    }

    if (depth !== 0) {
      i = startTagEnd + 1;
      continue;
    }

    const closeIdx = searchStart - closeSeq.length;
    const innerRaw = xml.slice(startTagEnd + 1, closeIdx).trim();

    pairs.push({ key: tag, value: innerRaw });
    i = searchStart;
  }

  return pairs;
}

function parseParamValue(value: string): string | number | boolean | null {
  if (!value || value === "") return null;

  const lower = value.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null") return null;

  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") {
    return num;
  }

  return value;
}

export function validateActionParams(
  action: Action,
  extractedParams: ActionParameters | undefined,
): { valid: boolean; params: ActionParameters | undefined; errors: string[] } {
  const errors: string[] = [];
  const params: ActionParameters = {};

  if (!action.parameters || action.parameters.length === 0) {
    return { valid: true, params: undefined, errors: [] };
  }

  for (const paramDef of action.parameters) {
    const extractedValue = extractedParams
      ? extractedParams[paramDef.name]
      : undefined;

    if (extractedValue === undefined || extractedValue === null) {
      if (paramDef.required) {
        errors.push(
          `Required parameter '${paramDef.name}' was not provided for action ${action.name}`,
        );
      } else if (paramDef.schema.default !== undefined) {
        params[paramDef.name] = paramDef.schema.default;
      }
    } else {
      const typeError = validateParamType(paramDef, extractedValue);
      if (typeError) {
        errors.push(typeError);
      } else {
        params[paramDef.name] = extractedValue;
      }
    }
  }

  return {
    valid: errors.length === 0,
    params: Object.keys(params).length > 0 ? params : undefined,
    errors,
  };
}

type ValidatableParamValue =
  | ActionParameterValue
  | ActionParameters
  | ActionParameterValue[]
  | ActionParameters[]
  | JsonValue;

function validateParamType(
  paramDef: ActionParameter,
  value: ValidatableParamValue,
): string | undefined {
  const { schema, name } = paramDef;

  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        return `Parameter '${name}' expected string, got ${typeof value}`;
      }
      const enumValues = schema.enumValues ?? schema.enum;
      if (enumValues && !enumValues.includes(value)) {
        return `Parameter '${name}' value '${value}' not in allowed values: ${enumValues.join(", ")}`;
      }
      if (schema.pattern) {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(value)) {
          return `Parameter '${name}' value '${value}' does not match pattern: ${schema.pattern}`;
        }
      }
      break;
    }

    case "number":
      if (typeof value !== "number") {
        return `Parameter '${name}' expected number, got ${typeof value}`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `Parameter '${name}' value ${value} is below minimum ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `Parameter '${name}' value ${value} is above maximum ${schema.maximum}`;
      }
      break;

    case "boolean":
      if (typeof value !== "boolean") {
        return `Parameter '${name}' expected boolean, got ${typeof value}`;
      }
      break;

    case "array":
      if (!Array.isArray(value)) {
        return `Parameter '${name}' expected array, got ${typeof value}`;
      }
      break;

    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `Parameter '${name}' expected object, got ${typeof value}`;
      }
      break;
  }

  return undefined;
}
