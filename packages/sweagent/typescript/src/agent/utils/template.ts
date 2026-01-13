/**
 * Simple template rendering utility
 * Replaces the need for external template libraries
 */

import type { JsonValue } from "../../json";

export type TemplateValue = JsonValue;
export type TemplateContext = Record<string, TemplateValue>;

function isTemplateRecord(
  value: TemplateValue,
): value is Record<string, TemplateValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Render a template string with the given context
 * Supports {{variable}} syntax
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match: string, key: string) => {
    const trimmedKey = key.trim();

    // Handle nested properties like {{object.property}}
    const value = trimmedKey.split(".").reduce<TemplateValue>((obj, prop) => {
      if (isTemplateRecord(obj) && prop in obj) {
        return obj[prop];
      }
      return "";
    }, context as TemplateValue);

    // Handle array indexing like {{array[0]}}
    if (trimmedKey.includes("[")) {
      const parts = trimmedKey.match(/([^[]+)\[(\d+)\]/);
      if (parts) {
        const [, arrayName, index] = parts;
        const array = context[arrayName.trim()];
        if (Array.isArray(array)) {
          return String(array[Number.parseInt(index, 10)] ?? "");
        }
      }
    }

    // Handle special filters
    if (trimmedKey.includes("|")) {
      const [varName, ...filters] = trimmedKey
        .split("|")
        .map((s: string) => s.trim());
      let val: TemplateValue = context[varName] ?? "";

      for (const filter of filters) {
        if (filter === "length" && typeof val === "string") {
          val = val.length;
        } else if (filter.startsWith("slice:")) {
          const [start, end] = filter
            .substring(6)
            .split(",")
            .map((n: string) => parseInt(n, 10));
          if (typeof val === "string" || Array.isArray(val)) {
            val = val.slice(start, end);
          }
        }
      }
      return String(val);
    }

    return value !== undefined ? String(value) : match;
  });
}

/**
 * Render a template with loops and conditionals
 * Supports {% for %}, {% if %}, {% endif %}, {% endfor %}
 */
export function renderAdvancedTemplate(
  template: string,
  context: TemplateContext,
): string {
  let result = template;

  // Handle for loops
  result = result.replace(
    /\{%\s*for\s+(\w+)\s+in\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/g,
    (_match, itemVar, arrayVar, loopBody) => {
      const array = context[arrayVar];
      if (!Array.isArray(array)) {
        return "";
      }

      return array
        .map((item, index) => {
          const loopContext: TemplateContext = {
            ...context,
            [itemVar]: item,
            [`${itemVar}_index`]: index,
            loop: {
              index,
              first: index === 0,
              last: index === array.length - 1,
            },
          };
          return renderTemplate(loopBody, loopContext);
        })
        .join("");
    },
  );

  // Handle if conditionals
  result = result.replace(
    /\{%\s*if\s+([^%]+)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
    (_match, condition, ifBody, elseBody = "") => {
      const evalCondition = evaluateCondition(condition.trim(), context);
      return evalCondition
        ? renderTemplate(ifBody, context)
        : renderTemplate(elseBody, context);
    },
  );

  // Finally render variables
  return renderTemplate(result, context);
}

/**
 * Simple condition evaluator for template conditionals
 */
function evaluateCondition(
  condition: string,
  context: TemplateContext,
): boolean {
  // Handle simple variable checks
  if (context[condition] !== undefined) {
    return !!context[condition];
  }

  // Handle comparisons
  const comparisonMatch = condition.match(/(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)/);
  if (comparisonMatch) {
    const [, left, operator, right] = comparisonMatch;
    const leftVal: TemplateValue = context[left] ?? left;
    const rightVal: TemplateValue =
      context[right] ??
      (right.startsWith('"') && right.endsWith('"')
        ? right.slice(1, -1)
        : right === "true" || right === "false"
          ? right === "true"
          : Number.isNaN(Number(right))
            ? right
            : Number(right));

    const maybeNumber = (value: TemplateValue): number | null => {
      if (typeof value === "number") {
        return value;
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      if (typeof value === "string") {
        const asNumber = Number(value);
        return Number.isNaN(asNumber) ? null : asNumber;
      }
      return null;
    };

    switch (operator) {
      case "==":
        return leftVal === rightVal;
      case "!=":
        return leftVal !== rightVal;
      case ">":
        return maybeNumber(leftVal) !== null && maybeNumber(rightVal) !== null
          ? (maybeNumber(leftVal) as number) > (maybeNumber(rightVal) as number)
          : String(leftVal) > String(rightVal);
      case "<":
        return maybeNumber(leftVal) !== null && maybeNumber(rightVal) !== null
          ? (maybeNumber(leftVal) as number) < (maybeNumber(rightVal) as number)
          : String(leftVal) < String(rightVal);
      case ">=":
        return maybeNumber(leftVal) !== null && maybeNumber(rightVal) !== null
          ? (maybeNumber(leftVal) as number) >=
              (maybeNumber(rightVal) as number)
          : String(leftVal) >= String(rightVal);
      case "<=":
        return maybeNumber(leftVal) !== null && maybeNumber(rightVal) !== null
          ? (maybeNumber(leftVal) as number) <=
              (maybeNumber(rightVal) as number)
          : String(leftVal) <= String(rightVal);
    }
  }

  // Handle 'not' operator
  if (condition.startsWith("not ")) {
    const varName = condition.substring(4).trim();
    return !context[varName];
  }

  return false;
}

/**
 * Template class for more complex rendering needs
 */
export class Template {
  private template: string;

  constructor(template: string) {
    this.template = template;
  }

  render(context: TemplateContext): string {
    return renderAdvancedTemplate(this.template, context);
  }
}
