/**
 * Simple template rendering utility
 * Replaces the need for external template libraries
 */

/**
 * Render a template string with the given context
 * Supports {{variable}} syntax
 */
export function renderTemplate(template: string, context: Record<string, any>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmedKey = key.trim();

    // Handle nested properties like {{object.property}}
    const value = trimmedKey.split('.').reduce((obj: unknown, prop: string) => {
      return obj && typeof obj === 'object' && obj !== null && prop in obj
        ? (obj as Record<string, unknown>)[prop]
        : '';
    }, context as unknown);

    // Handle array indexing like {{array[0]}}
    if (trimmedKey.includes('[')) {
      const parts = trimmedKey.match(/([^[]+)\[(\d+)\]/);
      if (parts) {
        const [, arrayName, index] = parts;
        const array = context[arrayName.trim()];
        if (Array.isArray(array)) {
          return array[parseInt(index)] || '';
        }
      }
    }

    // Handle special filters
    if (trimmedKey.includes('|')) {
      const [varName, ...filters] = trimmedKey.split('|').map((s: string) => s.trim());
      let val = context[varName] || '';

      for (const filter of filters) {
        if (filter === 'length' && typeof val === 'string') {
          val = val.length;
        } else if (filter.startsWith('slice:')) {
          const [start, end] = filter
            .substring(6)
            .split(',')
            .map((n: string) => parseInt(n));
          if (typeof val === 'string' || Array.isArray(val)) {
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
export function renderAdvancedTemplate(template: string, context: Record<string, any>): string {
  let result = template;

  // Handle for loops
  result = result.replace(
    /\{%\s*for\s+(\w+)\s+in\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/g,
    (_match, itemVar, arrayVar, loopBody) => {
      const array = context[arrayVar];
      if (!Array.isArray(array)) {
        return '';
      }

      return array
        .map((item, index) => {
          const loopContext = {
            ...context,
            [itemVar]: item,
            [`${itemVar}_index`]: index,
            loop: { index, first: index === 0, last: index === array.length - 1 },
          };
          return renderTemplate(loopBody, loopContext);
        })
        .join('');
    },
  );

  // Handle if conditionals
  result = result.replace(
    /\{%\s*if\s+([^%]+)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
    (_match, condition, ifBody, elseBody = '') => {
      const evalCondition = evaluateCondition(condition.trim(), context);
      return evalCondition ? renderTemplate(ifBody, context) : renderTemplate(elseBody, context);
    },
  );

  // Finally render variables
  return renderTemplate(result, context);
}

/**
 * Simple condition evaluator for template conditionals
 */
function evaluateCondition(condition: string, context: Record<string, any>): boolean {
  // Handle simple variable checks
  if (context[condition] !== undefined) {
    return !!context[condition];
  }

  // Handle comparisons
  const comparisonMatch = condition.match(/(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)/);
  if (comparisonMatch) {
    const [, left, operator, right] = comparisonMatch;
    const leftVal = context[left] !== undefined ? context[left] : left;
    const rightVal =
      context[right] !== undefined
        ? context[right]
        : right.startsWith('"') && right.endsWith('"')
          ? right.slice(1, -1)
          : right === 'true' || right === 'false'
            ? right === 'true'
            : isNaN(Number(right))
              ? right
              : Number(right);

    switch (operator) {
      case '==':
        return leftVal == rightVal;
      case '!=':
        return leftVal != rightVal;
      case '>':
        return leftVal > rightVal;
      case '<':
        return leftVal < rightVal;
      case '>=':
        return leftVal >= rightVal;
      case '<=':
        return leftVal <= rightVal;
    }
  }

  // Handle 'not' operator
  if (condition.startsWith('not ')) {
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

  render(context: Record<string, any>): string {
    return renderAdvancedTemplate(this.template, context);
  }
}
