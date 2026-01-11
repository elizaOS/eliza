import { names, uniqueNamesGenerator } from "unique-names-generator";
import type {
  Action,
  ActionExample,
  ActionParameter,
  ActionParameterSchema,
  ActionParameters,
  ActionParameterValue,
} from "./types";

/**
 * Composes a set of example conversations based on provided actions and a specified count.
 * It randomly selects examples from the provided actions and formats them with generated names.
 *
 * @param actionsData - An array of `Action` objects from which to draw examples.
 * @param count - The number of examples to generate.
 * @returns A string containing formatted examples of conversations.
 */
export const composeActionExamples = (
  actionsData: Action[],
  count: number,
): string => {
  // Handle edge cases
  if (!actionsData.length || count <= 0) {
    return "";
  }

  // Filter out actions without examples
  const actionsWithExamples = actionsData.filter(
    (action) =>
      action.examples &&
      Array.isArray(action.examples) &&
      action.examples.length > 0,
  );

  // If no actions have examples, return empty string
  if (!actionsWithExamples.length) {
    return "";
  }

  // Create a working copy of the examples
  const examplesCopy: ActionExample[][][] = actionsWithExamples.map(
    (action) => [...(action.examples || [])],
  );

  const selectedExamples: ActionExample[][] = [];

  // Keep track of actions that still have examples
  const availableActionIndices = examplesCopy
    .map((examples, index) => (examples.length > 0 ? index : -1))
    .filter((index) => index !== -1);

  // Select examples until we reach the count or run out of examples
  while (selectedExamples.length < count && availableActionIndices.length > 0) {
    // Randomly select an action
    const randomIndex = Math.floor(
      Math.random() * availableActionIndices.length,
    );
    const actionIndex = availableActionIndices[randomIndex];
    const examples = examplesCopy[actionIndex];

    // Select a random example from this action
    const exampleIndex = Math.floor(Math.random() * examples.length);
    selectedExamples.push(examples.splice(exampleIndex, 1)[0]);

    // Remove action if it has no more examples
    if (examples.length === 0) {
      availableActionIndices.splice(randomIndex, 1);
    }
  }

  // Format the selected examples
  return formatSelectedExamples(selectedExamples);
};

/**
 * Formats selected example conversations with random names.
 */
const formatSelectedExamples = (examples: ActionExample[][]): string => {
  const MAX_NAME_PLACEHOLDERS = 5;

  return examples
    .map((example) => {
      // Generate random names for this example
      const randomNames = Array.from({ length: MAX_NAME_PLACEHOLDERS }, () =>
        uniqueNamesGenerator({ dictionaries: [names] }),
      );

      // Format the conversation
      const conversation = example
        .map((message) => {
          // Build the base message - only include the text, no action info
          let messageText = `${message.name}: ${message.content.text}`;

          // Replace name placeholders
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

/**
 * Formats the names of the provided actions into a comma-separated string.
 * @param actions - An array of `Action` objects from which to extract names.
 * @returns A comma-separated string of action names.
 */
export function formatActionNames(actions: Action[]): string {
  if (!actions || !actions.length) return "";

  // Create a shuffled copy instead of mutating the original array
  return [...actions]
    .sort(() => Math.random() - 0.5)
    .map((action) => action.name)
    .join(", ");
}

/**
 * Formats the provided actions into a detailed string listing each action's name and description.
 * @param actions - An array of `Action` objects to format.
 * @returns A detailed string of actions, including names and descriptions.
 */
export function formatActions(actions: Action[]): string {
  if (!actions || !actions.length) return "";

  // Create a shuffled copy without mutating the original
  return [...actions]
    .sort(() => Math.random() - 0.5)
    .map((action) => {
      let actionText = `- **${action.name}**: ${action.description || "No description available"}`;

      // Add parameter documentation if the action has parameters
      if (action.parameters && action.parameters.length > 0) {
        const paramsText = formatActionParameters(action.parameters);
        actionText += `\n  Parameters:\n${paramsText}`;
      }

      return actionText;
    })
    .join("\n");
}

/**
 * Formats action parameters into a readable string for the prompt.
 * @param parameters - Array of ActionParameter objects
 * @returns Formatted string describing the parameters
 */
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

      return `    - ${param.name}${requiredStr}: ${param.description} (${typeStr}${enumStr}${defaultStr})`;
    })
    .join("\n");
}

/**
 * Formats the parameter type into a human-readable string.
 * @param schema - The ActionParameterSchema to format
 * @returns Human-readable type string
 */
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

/**
 * Extracts and parses nested XML params block from parsed response.
 * Handles the <params><ACTION_NAME><paramName>value</paramName></ACTION_NAME></params> structure.
 *
 * @param paramsXml - The raw params XML string from the response
 * @returns Map of action names to their extracted parameters
 */
export function parseActionParams(
  paramsXml: string | undefined | null,
): Map<string, ActionParameters> {
  const result = new Map<string, ActionParameters>();

  if (!paramsXml || typeof paramsXml !== "string") {
    return result;
  }

  // Extract action blocks from the params XML
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

/**
 * Extract direct child XML elements from a string.
 * @param xml - The XML content to parse
 * @returns Array of key-value pairs
 */
function extractXmlChildren(
  xml: string,
): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  const length = xml.length;
  let i = 0;

  while (i < length) {
    const openIdx = xml.indexOf("<", i);
    if (openIdx === -1) break;

    // Skip closing tags and comments
    if (
      xml.startsWith("</", openIdx) ||
      xml.startsWith("<!--", openIdx) ||
      xml.startsWith("<?", openIdx)
    ) {
      i = openIdx + 1;
      continue;
    }

    // Extract tag name
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

    // Find end of start tag
    const startTagEnd = xml.indexOf(">", j);
    if (startTagEnd === -1) break;

    // Self-closing tag?
    const startTagText = xml.slice(openIdx, startTagEnd + 1);
    if (/\/\s*>$/.test(startTagText)) {
      i = startTagEnd + 1;
      continue;
    }

    // Find matching close tag with nesting support
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

/**
 * Parse a parameter value, attempting to convert to appropriate type.
 * @param value - The string value to parse
 * @returns Parsed value (string, number, boolean, or null)
 */
function parseParamValue(value: string): string | number | boolean | null {
  if (!value || value === "") return null;

  // Check for boolean
  const lower = value.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null") return null;

  // Check for number
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") {
    return num;
  }

  return value;
}

/**
 * Validates action parameters against the action's parameter definitions.
 * Applies defaults for optional parameters that weren't provided.
 *
 * @param action - The action with parameter definitions
 * @param extractedParams - Parameters extracted from LLM response
 * @returns Validated parameters with defaults applied, or null if validation fails
 */
export function validateActionParams(
  action: Action,
  extractedParams: ActionParameters | undefined,
): { valid: boolean; params: ActionParameters | undefined; errors: string[] } {
  const errors: string[] = [];
  const params: ActionParameters = {};

  if (!action.parameters || action.parameters.length === 0) {
    // No parameters defined, nothing to validate
    return { valid: true, params: undefined, errors: [] };
  }

  for (const paramDef of action.parameters) {
    const extractedValue = extractedParams
      ? extractedParams[paramDef.name]
      : undefined;

    if (extractedValue === undefined || extractedValue === null) {
      // Parameter not provided
      if (paramDef.required) {
        errors.push(
          `Required parameter '${paramDef.name}' was not provided for action ${action.name}`,
        );
      } else if (paramDef.schema.default !== undefined) {
        // Apply default value
        params[paramDef.name] = paramDef.schema.default;
      }
      // Optional params without defaults remain undefined
    } else {
      // Validate type
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

/**
 * Type for values that can be validated in action parameters.
 */
type ValidatableParamValue =
  | ActionParameterValue
  | ActionParameters
  | ActionParameterValue[]
  | ActionParameters[];

/**
 * Validates a parameter value against its schema type.
 * @param paramDef - The parameter definition
 * @param value - The value to validate
 * @returns Error message if invalid, undefined if valid
 */
function validateParamType(
  paramDef: ActionParameter,
  value: ValidatableParamValue,
): string | undefined {
  const { schema, name } = paramDef;

  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        return `Parameter '${name}' expected string, got ${typeof value}`;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return `Parameter '${name}' value '${value}' not in allowed values: ${schema.enum.join(", ")}`;
      }
      if (schema.pattern) {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(value)) {
          return `Parameter '${name}' value '${value}' does not match pattern: ${schema.pattern}`;
        }
      }
      break;

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
