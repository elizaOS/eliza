import * as fs from 'fs';
import { parse, ParserOptions } from '@typescript-eslint/parser';
import { ActionBounds, ActionMetadata } from './types';

/**
 * A class for parsing TypeScript files.
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
            const parserOptions: ParserOptions = {
                sourceType: 'module',
                ecmaVersion: 2020,
                ecmaFeatures: {
                    jsx: true
                },
                range: true,
                loc: true,
                tokens: true,
                comment: true,
                errorOnUnknownASTType: false,
                errorOnTypeScriptSyntacticAndSemanticIssues: false
            };

            const ast = parse(content, parserOptions);
            if (!ast || typeof ast !== 'object') {
                console.warn(`Warning: Invalid AST generated for file ${file}`);
                return null;
            }
            return ast;
        } catch (error) {
            if (error instanceof Error) {
                this.handleParseError(error);
            } else {
                console.error('Unknown error:', error);
            }
            return null;
        }
    }

    public extractExports(file: string): { actions: string[], providers: string[], evaluators: string[] } {
        //const content = fs.readFileSync(file, 'utf-8');
        const ast = this.parse(file);

        const exports: { actions: string[], providers: string[], evaluators: string[] } = {
            actions: [],
            providers: [],
            evaluators: [],
          };

        if (ast) {
          // Traverse the AST to find export declarations
          ast.body.forEach((node: any) => {
            if (node.type === 'ImportDeclaration') {
                const source = node.source.value;
                if (source.startsWith('./actions/')) {
                  exports.actions.push(source);
                } else if (source.startsWith('./providers/')) {
                  exports.providers.push(source);
                } else if (source.startsWith('./evaluators/')) {
                  exports.evaluators.push(source);
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
            if (node?.type === 'Property' &&
                node?.key?.type === 'Identifier' &&
                node?.key?.name === 'name' &&
                node?.value?.type === 'Literal') {
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

    private handleParseError(error: Error): void {
        console.error('Error parsing TypeScript file:', error.message);
    }
}
