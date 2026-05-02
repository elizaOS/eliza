/**
 * Response validation utilities
 */

import { ElizaResponse, TestPrompt } from "./types";

/**
 * Check if a response contains expected patterns
 */
export function validateResponse(
  response: ElizaResponse,
  prompt: TestPrompt
): { success: boolean; matchedPatterns: string[]; error?: string } {
  if (!response || !response.text) {
    return {
      success: false,
      matchedPatterns: [],
      error: "No response received",
    };
  }

  const responseText = response.text.toLowerCase();
  const matchedPatterns: string[] = [];
  
  // Check for expected patterns
  for (const pattern of prompt.expectedPatterns) {
    if (isPatternMatch(responseText, pattern.toLowerCase())) {
      matchedPatterns.push(pattern);
    }
  }

  // Check for expected actions if specified
  if (prompt.expectedActions && prompt.expectedActions.length > 0) {
    const responseActions = (response.actions || []).map(a => a.toLowerCase());
    const expectedActions = prompt.expectedActions.map(a => a.toLowerCase());
    
    const missingActions = expectedActions.filter(
      action => !responseActions.includes(action)
    );
    
    if (missingActions.length > 0) {
      return {
        success: false,
        matchedPatterns,
        error: `Missing expected actions: ${missingActions.join(", ")}`,
      };
    }
  }

  // Determine success
  const success = matchedPatterns.length > 0 || 
    (prompt.expectedPatterns.length === 0 && !prompt.expectedActions);

  return {
    success,
    matchedPatterns,
    error: success ? undefined : "No expected patterns found in response",
  };
}

/**
 * Check if a pattern matches in text (supports wildcards and regex)
 */
function isPatternMatch(text: string, pattern: string): boolean {
  // Check for exact match
  if (text.includes(pattern)) {
    return true;
  }

  // Check for wildcard pattern (using * as wildcard)
  if (pattern.includes("*")) {
    const regexPattern = pattern
      .split("*")
      .map(part => escapeRegex(part))
      .join(".*");
    const regex = new RegExp(regexPattern, "i");
    return regex.test(text);
  }

  // Check for regex pattern (if starts with /)
  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      const regex = new RegExp(pattern.slice(1, -1), "i");
      return regex.test(text);
    } catch {
      // Invalid regex, treat as literal
      return text.includes(pattern);
    }
  }

  return false;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract numeric values from response
 */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d+\.?\d*/g);
  return matches ? matches.map(Number) : [];
}

/**
 * Validate typewriter response
 */
export function validateTypewriterResponse(
  response: ElizaResponse,
  expectedText: string
): boolean {
  const responseText = response.text.toLowerCase();
  const expected = expectedText.toLowerCase();
  
  // Check if the typed text appears in the response
  return responseText.includes(expected) || 
    responseText.includes(`typed: ${expected}`) ||
    responseText.includes(`text: ${expected}`);
}

/**
 * Validate math operation response
 */
export function validateMathResponse(
  response: ElizaResponse,
  operation: string,
  expectedRange?: { min: number; max: number }
): { success: boolean; value?: number; error?: string } {
  const numbers = extractNumbers(response.text);
  
  if (numbers.length === 0) {
    return {
      success: false,
      error: "No numeric result found in response",
    };
  }

  // Get the likely result (usually the last number mentioned)
  const result = numbers[numbers.length - 1];
  
  // Check if result is in expected range
  if (expectedRange) {
    const inRange = result >= expectedRange.min && result <= expectedRange.max;
    return {
      success: inRange,
      value: result,
      error: inRange ? undefined : 
        `Result ${result} outside expected range [${expectedRange.min}, ${expectedRange.max}]`,
    };
  }

  // For operations without specific range, just check that we got a number
  return {
    success: true,
    value: result,
  };
}

/**
 * Validate relational data response
 */
export function validateRelationalResponse(
  response: ElizaResponse,
  expectedEntities?: string[],
  expectedRelationships?: string[]
): { success: boolean; found: string[]; missing: string[] } {
  const responseText = response.text.toLowerCase();
  const found: string[] = [];
  const missing: string[] = [];

  // Check for entities
  if (expectedEntities) {
    for (const entity of expectedEntities) {
      if (responseText.includes(entity.toLowerCase())) {
        found.push(entity);
      } else {
        missing.push(entity);
      }
    }
  }

  // Check for relationships
  if (expectedRelationships) {
    for (const relationship of expectedRelationships) {
      if (responseText.includes(relationship.toLowerCase())) {
        found.push(relationship);
      } else {
        missing.push(relationship);
      }
    }
  }

  return {
    success: missing.length === 0,
    found,
    missing,
  };
}

/**
 * Validate that certain words or phrases are NOT in the response
 */
export function validateAbsence(
  response: ElizaResponse,
  forbiddenPatterns: string[]
): { success: boolean; foundForbidden: string[] } {
  const responseText = response.text.toLowerCase();
  const foundForbidden: string[] = [];

  for (const pattern of forbiddenPatterns) {
    if (isPatternMatch(responseText, pattern.toLowerCase())) {
      foundForbidden.push(pattern);
    }
  }

  return {
    success: foundForbidden.length === 0,
    foundForbidden,
  };
}

/**
 * Validate response time is within acceptable range
 */
export function validateResponseTime(
  responseTime: number,
  maxTime: number
): boolean {
  return responseTime <= maxTime;
}

/**
 * Create a composite validator from multiple validation functions
 */
export function createCompositeValidator(
  validators: Array<(response: ElizaResponse) => { success: boolean; error?: string }>
): (response: ElizaResponse) => { success: boolean; errors: string[] } {
  return (response: ElizaResponse) => {
    const errors: string[] = [];
    let success = true;

    for (const validator of validators) {
      const result = validator(response);
      if (!result.success) {
        success = false;
        if (result.error) {
          errors.push(result.error);
        }
      }
    }

    return { success, errors };
  };
}
