import * as fs from 'fs';
import { parse, ParserOptions } from '@typescript-eslint/parser';

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

    /**
     * Handles a parse error that occurs during TypeScript parsing.
     * 
     * @param {Error} error - The error that occurred during parsing
     * @returns {void}
     */
    public handleParseError(error: Error): void {
        console.error('TypeScript Parsing Error:', error);
    }
}