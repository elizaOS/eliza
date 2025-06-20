import fs from 'node:fs';
import { type ParserOptions, parse } from '@typescript-eslint/parser';
import { type ActionBounds, ActionMetadata } from './types';

/**
 * A class for parsing TypeScript files.
 */
/**
 * Class representing a TypeScriptParser.
 */

/**
 * Parses the content of a file using the given file path.
 *
 * @param {string} file - The file path containing the content to be parsed.
 * @returns {any} The abstract syntax tree (AST) representation of the parsed content.
 */

/**
 * Extracts actions, providers, and evaluators from a file.
 *
 * @param {string} file - The file path containing the content to be parsed.
 * @returns {{actions: string[]; providers: string[]; evaluators: string[]}} An object containing arrays of actions, providers, and evaluators.
 */

/**
 * Finds the start and end line numbers of an action in the abstract syntax tree (AST).
 *
 * @param {any} ast - The abstract syntax tree (AST) representation of the parsed content.
 * @returns {ActionBounds | null} An object containing the start and end line numbers of the action or null if not found.
 */

/**
 * Extracts the code of an action from a file based on the given bounds.
 *
 * @param {string} filePath - The file path containing the content to be parsed.
 * @param {ActionBounds} bounds - An object containing the start and end line numbers of the action.
 * @returns {string} The extracted code of the action.
 */
export class TypeScriptParser {
  /**
   * Parses the content of a file using the given file path.
   *
   * @param {string} file - The file path containing the content to be parsed.
   * @returns {any} The abstract syntax tree (AST) representation of the parsed content.
   */
  public parse(file: string): any {
    try {
      const content = fs.readFileSync(file, 'utf-8');

      // Determine if this is a TSX file based on file extension or JSX syntax
      const isTsxFile =
        file.endsWith('.tsx') ||
        (content.includes('<') && content.includes('>') && content.includes('React'));

      const parserOptions: ParserOptions = {
        sourceType: 'module',
        ecmaVersion: 'latest',
        ecmaFeatures: {
          jsx: true,
          globalReturn: false,
        },
        range: true,
        loc: true,
        tokens: true,
        comment: true,
        errorOnUnknownASTType: false,
        errorOnTypeScriptSyntacticAndSemanticIssues: false,
        // Add project configuration for better TypeScript support
        project: undefined, // Don't use project-based parsing to avoid config issues
        extraFileExtensions: ['.tsx'],
      };

      const ast = parse(content, parserOptions);
      if (!ast || typeof ast !== 'object') {
        console.warn(`Warning: Invalid AST generated for file ${file}`);
        return null;
      }
      return ast;
    } catch (error) {
      if (error instanceof Error) {
        this.handleParseError(error, file);
      } else {
        console.error('Unknown error:', error);
      }
      return null;
    }
  }

  public extractExports(file: string): {
    actions: string[];
    providers: string[];
    evaluators: string[];
  } {
    //const content = fs.readFileSync(file, 'utf-8');
    const ast = this.parse(file);

    const exports: {
      actions: string[];
      providers: string[];
      evaluators: string[];
    } = {
      actions: [],
      providers: [],
      evaluators: [],
    };

    if (ast && ast.body) {
      // Traverse the AST to find export declarations
      ast.body.forEach((node: any) => {
        if (node.type === 'ImportDeclaration') {
          const source = node.source?.value;
          if (typeof source === 'string') {
            if (source.startsWith('./actions/')) {
              exports.actions.push(source);
            } else if (source.startsWith('./providers/')) {
              exports.providers.push(source);
            } else if (source.startsWith('./evaluators/')) {
              exports.evaluators.push(source);
            }
          }
        }
      });
    }

    return exports;
  }

  public findActionBounds(ast: any): ActionBounds | null {
    let startLine: number | null = null;
    let endLine: number | null = null;
    let actionNameStartLine: number | null = null;

    // write ast to json file
    // fs.writeFileSync("ast.json", JSON.stringify(ast, null, 2));

    const findActionTypeAnnotation = (node: any) => {
      // Look for Action type annotation
      if (node?.typeAnnotation?.typeAnnotation?.typeName?.name === 'Action') {
        startLine = node.loc.start.line;
      }

      // Look for ActionExample type annotation to find the end
      if (node?.typeAnnotation?.elementType?.elementType?.typeName?.name === 'ActionExample') {
        endLine = node.loc.end.line;
      }

      // Backup: Look for action name property
      if (
        node?.type === 'Property' &&
        node?.key?.type === 'Identifier' &&
        node?.key?.name === 'name' &&
        node?.value?.type === 'Literal'
      ) {
        actionNameStartLine = node.loc.start.line;
      }

      // Recursively search in child nodes
      for (const key in node) {
        if (node[key] && typeof node[key] === 'object') {
          if (Array.isArray(node[key])) {
            node[key].forEach(findActionTypeAnnotation);
          } else {
            findActionTypeAnnotation(node[key]);
          }
        }
      }
    };

    findActionTypeAnnotation(ast);

    // If we found a valid end line but no start line, use the action name line as fallback
    if (!startLine && actionNameStartLine && endLine) {
      console.log('Using action name line as fallback');
      startLine = actionNameStartLine;
    }

    if (startLine && endLine) {
      return { startLine, endLine };
    }

    return null;
  }

  public extractActionCode(filePath: string, bounds: ActionBounds): string {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    // Extract lines from start to end (inclusive)
    return lines.slice(bounds.startLine - 1, bounds.endLine).join('\n');
  }

  private handleParseError(error: Error, file?: string): void {
    const fileInfo = file ? ` in file ${file}` : '';
    console.error(`Error parsing TypeScript file${fileInfo}:`, error.message);

    // Don't log full stack trace for parsing errors to reduce noise
    if (error.message.includes('Unexpected token')) {
      console.warn(
        `Skipping file due to parsing error${fileInfo}. This might be due to unsupported syntax.`
      );
    }
  }
}
