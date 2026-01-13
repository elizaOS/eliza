/**
 * Simple template rendering utilities
 * Provides basic Jinja2-style template rendering functionality
 */

/**
 * Render a template string with the given context
 * Supports:
 * - Variable substitution: {{variable}}
 * - Conditional blocks: {% if condition %} ... {% endif %}
 * - For loops: {% for item in items %} ... {% endfor %}
 */
/**
 * Render a template string with the given context, replacing placeholders with values
 * @param template - The template string with {{variable}} placeholders
 * @param context - Object containing values to replace in the template
 * @returns The rendered template string
 */
export function renderTemplate(template: string, context: Record<string, unknown>): string {
  if (!template) {
    return '';
  }

  let result = template;

  // Handle conditional blocks {% if ... %} ... {% elif ... %} ... {% else %} ... {% endif %}
  result = handleConditionals(result, context);

  // Handle for loops {% for item in items %} ... {% endfor %}
  result = handleForLoops(result, context);

  // Handle variable substitution {{variable}}
  result = handleVariables(result, context);

  // Handle filters like {{variable|default('default_value')}}
  result = handleFilters(result, context);

  return result;
}

/**
 * Handle conditional blocks
 */
function handleConditionals(template: string, context: Record<string, any>): string {
  const conditionalRegex = /{%\s*if\s+(.*?)\s*%}(.*?)(?:{%\s*else\s*%}(.*?))?{%\s*endif\s*%}/gs;

  return template.replace(conditionalRegex, (_match, condition, ifBlock, elseBlock = '') => {
    const evalCondition = evaluateCondition(condition, context);
    return evalCondition ? ifBlock : elseBlock;
  });
}

/**
 * Handle for loops
 */
function handleForLoops(template: string, context: Record<string, any>): string {
  const forRegex = /{%\s*for\s+(\w+)\s+in\s+(\w+)\s*%}(.*?){%\s*endfor\s*%}/gs;

  return template.replace(forRegex, (_match, itemName, listName, loopBody) => {
    const items = context[listName];
    if (!Array.isArray(items)) {
      return '';
    }

    return items
      .map((item) => {
        const loopContext = { ...context, [itemName]: item };
        return renderTemplate(loopBody, loopContext);
      })
      .join('');
  });
}

/**
 * Handle variable substitution
 */
function handleVariables(template: string, context: Record<string, any>): string {
  const variableRegex = /{{(\s*[\w.]+\s*)}}/g;

  return template.replace(variableRegex, (match, variable) => {
    const trimmedVar = variable.trim();
    const value = getNestedValue(context, trimmedVar);
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Handle template filters
 */
function handleFilters(template: string, context: Record<string, any>): string {
  const filterRegex = /{{(\s*[\w.]+\s*\|\s*\w+(?:\([^)]*\))?)\s*}}/g;

  return template.replace(filterRegex, (match, expression) => {
    const [variable, ...filterParts] = expression.split('|').map((s: string) => s.trim());
    let value = getNestedValue(context, variable);

    if (filterParts.length > 0) {
      const filterStr = filterParts.join('|');
      value = applyFilter(value, filterStr);
    }

    return value !== undefined ? String(value) : match;
  });
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj;

  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Evaluate a condition in the given context
 */
function evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
  // Handle simple variable checks
  if (condition in context) {
    return Boolean(context[condition]);
  }

  // Handle == comparisons
  const eqMatch = condition.match(/(\w+)\s*==\s*["']([^"']+)["']/);
  if (eqMatch) {
    const [, variable, value] = eqMatch;
    return context[variable] === value;
  }

  // Handle != comparisons
  const neqMatch = condition.match(/(\w+)\s*!=\s*["']([^"']+)["']/);
  if (neqMatch) {
    const [, variable, value] = neqMatch;
    return context[variable] !== value;
  }

  // Handle 'not' operator
  if (condition.startsWith('not ')) {
    const variable = condition.substring(4).trim();
    return !context[variable];
  }

  // Default to false for unrecognized conditions
  return false;
}

/**
 * Apply a filter to a value
 */
function applyFilter(value: unknown, filterStr: string): unknown {
  const filterMatch = filterStr.match(/(\w+)(?:\(([^)]*)\))?/);
  if (!filterMatch) {
    return value;
  }

  const [, filterName, filterArgs] = filterMatch;

  switch (filterName) {
    case 'default':
      if (value === undefined || value === null || value === '') {
        // Parse the default value from the arguments
        const defaultMatch = filterArgs?.match(/["']([^"']+)["']/);
        return defaultMatch ? defaultMatch[1] : '';
      }
      return value;

    case 'upper':
      return String(value).toUpperCase();

    case 'lower':
      return String(value).toLowerCase();

    case 'capitalize':
      const str = String(value);
      return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();

    case 'length':
      if (Array.isArray(value) || typeof value === 'string') {
        return value.length;
      }
      return 0;

    case 'join':
      if (Array.isArray(value)) {
        const separator = filterArgs?.replace(/["']/g, '') || ', ';
        return value.join(separator);
      }
      return value;

    default:
      return value;
  }
}

/**
 * Escape special characters in a string for use in templates
 */
export function escapeTemplate(str: string): string {
  return str.replace(/{{/g, '\\{\\{').replace(/}}/g, '\\}\\}').replace(/{%/g, '\\{\\%').replace(/%}/g, '\\%\\}');
}

/**
 * Check if a string contains template syntax
 */
export function hasTemplateSyntax(str: string): boolean {
  return /{{.*?}}|{%.*?%}/.test(str);
}
