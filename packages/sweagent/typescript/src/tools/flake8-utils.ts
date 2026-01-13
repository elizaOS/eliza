/**
 * Flake8 utilities for linting and error formatting
 * Converted from Python flake8_utils.py
 */

export interface Flake8Error {
  file: string;
  line: number;
  column: number;
  message: string;
}

export class Flake8ErrorClass implements Flake8Error {
  constructor(
    public file: string,
    public line: number,
    public column: number,
    public message: string,
  ) {}

  /**
   * Parse a flake8 error line and create a Flake8Error object
   */
  static fromLine(line: string): Flake8ErrorClass {
    // Parse format: "file.py:12:41: E999 SyntaxError: invalid syntax"
    const match = line.match(/^(.+):(\d+):(\d+):\s*(.+)$/);

    if (!match) {
      throw new Error(`Invalid flake8 error line: ${line}`);
    }

    const [, file, lineNum, colNum, message] = match;

    return new Flake8ErrorClass(file, parseInt(lineNum, 10), parseInt(colNum, 10), message);
  }

  toString(): string {
    return `${this.file}:${this.line}:${this.column}: ${this.message}`;
  }
}

/**
 * Format flake8 output, filtering out errors that existed before
 */
export function formatFlake8Output(
  currentErrors: string,
  previousErrorsString: string,
  replacementWindow: [number, number],
  replacementNLines: number,
  showLineNumbers: boolean = false,
): string {
  if (!currentErrors.trim()) {
    return '';
  }

  // Parse current errors
  const currentErrorsList = parseFlake8Output(currentErrors);
  const previousErrorsList = parseFlake8Output(previousErrorsString);

  // Update previous errors based on replacement window
  const updatedPreviousErrors = updatePreviousErrors(previousErrorsList, replacementWindow, replacementNLines);

  // Find new errors (errors in current that aren't in updated previous)
  const newErrors = findNewErrors(currentErrorsList, updatedPreviousErrors);

  // Format output
  if (newErrors.length === 0) {
    return '';
  }

  return formatErrorsForDisplay(newErrors, showLineNumbers);
}

/**
 * Parse flake8 output into error objects
 */
function parseFlake8Output(output: string): Flake8ErrorClass[] {
  if (!output.trim()) {
    return [];
  }

  const lines = output.trim().split('\n');
  const errors: Flake8ErrorClass[] = [];

  for (const line of lines) {
    if (line.trim()) {
      try {
        errors.push(Flake8ErrorClass.fromLine(line));
      } catch {
        // Skip invalid lines
      }
    }
  }

  return errors;
}

/**
 * Update line numbers of previous errors based on replacement
 */
function updatePreviousErrors(
  previousErrors: Flake8ErrorClass[],
  replacementWindow: [number, number],
  replacementNLines: number,
): Flake8ErrorClass[] {
  const [startLine, endLine] = replacementWindow;
  const linesDeleted = endLine - startLine + 1;
  const linesDelta = replacementNLines - linesDeleted;

  const updated: Flake8ErrorClass[] = [];

  for (const error of previousErrors) {
    // Skip errors within the replacement window
    if (error.line >= startLine && error.line <= endLine) {
      continue;
    }

    // Adjust line numbers for errors after the replacement
    if (error.line > endLine) {
      updated.push(new Flake8ErrorClass(error.file, error.line + linesDelta, error.column, error.message));
    } else {
      updated.push(error);
    }
  }

  return updated;
}

/**
 * Find errors that are new (not in the previous errors)
 */
function findNewErrors(currentErrors: Flake8ErrorClass[], previousErrors: Flake8ErrorClass[]): Flake8ErrorClass[] {
  const previousSet = new Set(previousErrors.map((e) => e.toString()));

  return currentErrors.filter((error) => !previousSet.has(error.toString()));
}

/**
 * Format errors for display
 */
function formatErrorsForDisplay(errors: Flake8ErrorClass[], showLineNumbers: boolean): string {
  if (errors.length === 0) {
    return '';
  }

  return errors
    .map((error) => {
      if (showLineNumbers) {
        return `- line ${error.line} col ${error.column}: ${error.message}`;
      }
      return `- ${error.message}`;
    })
    .join('\n');
}
