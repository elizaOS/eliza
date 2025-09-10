import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { ModelType, parseKeyValueXml } from '@elizaos/core';

// Safe math expression evaluator
function safeEvaluate(expression: string): number {
  // Remove spaces and validate characters
  const cleanExpr = expression.replace(/\s/g, '');

  // Check for invalid characters - matching Python's allowed characters
  if (!/^[0-9+\-*/(). ]+$/.test(cleanExpr)) {
    throw new Error('Invalid characters in expression');
  }

  // Check for balanced parentheses
  let parenCount = 0;
  for (const char of cleanExpr) {
    if (char === '(') parenCount++;
    if (char === ')') parenCount--;
    if (parenCount < 0) throw new Error('Unbalanced parentheses');
  }
  if (parenCount !== 0) throw new Error('Unbalanced parentheses');

  // Simple recursive descent parser
  let index = 0;

  function parseNumber(): number {
    let numStr = '';
    let hasDecimal = false;

    while (
      index < cleanExpr.length &&
      ((cleanExpr[index] >= '0' && cleanExpr[index] <= '9') ||
        (cleanExpr[index] === '.' && !hasDecimal))
    ) {
      if (cleanExpr[index] === '.') hasDecimal = true;
      numStr += cleanExpr[index];
      index++;
    }

    if (numStr === '' || numStr === '.') {
      throw new Error('Invalid number format');
    }

    return parseFloat(numStr);
  }

  function parseFactor(): number {
    if (cleanExpr[index] === '(') {
      index++; // Skip '('
      const result = parseExpression();
      if (cleanExpr[index] !== ')') {
        throw new Error('Expected closing parenthesis');
      }
      index++; // Skip ')'
      return result;
    }

    // Handle unary minus
    if (cleanExpr[index] === '-') {
      index++;
      return -parseFactor();
    }

    return parseNumber();
  }

  function parseTerm(): number {
    let result = parseFactor();

    while (index < cleanExpr.length && (cleanExpr[index] === '*' || cleanExpr[index] === '/')) {
      const operator = cleanExpr[index];
      index++;
      const right = parseFactor();

      if (operator === '*') {
        result *= right;
      } else if (operator === '/') {
        if (right === 0) throw new Error('Division by zero');
        result /= right;
      }
    }

    return result;
  }

  function parseExpression(): number {
    let result = parseTerm();

    while (index < cleanExpr.length && (cleanExpr[index] === '+' || cleanExpr[index] === '-')) {
      const operator = cleanExpr[index];
      index++;
      const right = parseTerm();

      if (operator === '+') {
        result += right;
      } else {
        result -= right;
      }
    }

    return result;
  }

  const result = parseExpression();

  if (index < cleanExpr.length) {
    throw new Error('Unexpected character in expression');
  }

  return result;
}

export const calculate: Action = {
  name: 'CALCULATE',
  description: 'Calculate the result of a mathematical expression.',
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    // Use LLM to extract parameters with XML format
    const extractionPrompt = `Extract the mathematical expression from the user message.

User message: "${message.content.text}"

The function requires these parameters:
- expression: The mathematical expression to evaluate (e.g., "49.99 * 3", "150 + 25% of 150", "(100 - 20) * 1.08")

Note: The expression should include all numbers, operators (+, -, *, /), and parentheses exactly as they appear or are implied in the message.

Respond with ONLY the extracted parameters in this XML format:
<response>
  <expression>extracted mathematical expression</expression>
</response>

If no mathematical expression can be found, use empty string for the expression.`;

    try {
      // Use small model for parameter extraction
      const extractionResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: extractionPrompt,
      });

      // Parse XML response using parseKeyValueXml
      const parsedParams = parseKeyValueXml(extractionResult);

      let expression = parsedParams?.expression?.trim();

      if (!expression) {
        const errorMsg =
          "I couldn't calculate that expression. Please use basic math operations (+, -, *, /) and numbers.";
        if (callback) {
          await callback({
            text: errorMsg,
            source: message.content.source,
          });
        }
        return {
          success: false,
          text: errorMsg,
          error: errorMsg,
        };
      }

      // Handle percentage calculations (e.g., "25% of 150" -> "0.25 * 150")
      expression = expression.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/g, '($1/100)*$2');
      expression = expression.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)');

      // Evaluate the expression
      const result = safeEvaluate(expression);

      // Round to 2 decimal places
      const roundedResult = Math.round(result * 100) / 100;

      if (callback) {
        await callback({
          text: `The result of ${expression} is ${roundedResult}.`,
          source: message.content.source,
        });
      }

      return {
        success: true,
        text: roundedResult.toString(),
        values: {
          lastCalculation: {
            expression,
            result: roundedResult,
          },
        },
        data: {
          expression,
          result: roundedResult,
        },
      };
    } catch (error) {
      let errorMsg: string;

      if (error instanceof Error) {
        if (error.message.includes('Division by zero')) {
          errorMsg = 'Cannot divide by zero.';
        } else {
          errorMsg =
            "I couldn't calculate that expression. Please use basic math operations (+, -, *, /) and numbers.";
        }
      } else {
        errorMsg =
          "I couldn't calculate that expression. Please use basic math operations (+, -, *, /) and numbers.";
      }

      if (callback) {
        await callback({
          text: errorMsg,
          source: message.content.source,
        });
      }

      return {
        success: false,
        text: errorMsg,
        error: errorMsg,
      };
    }
  },
};
