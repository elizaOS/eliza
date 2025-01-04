import { parse, ParserOptions } from '@typescript-eslint/parser';
import { AIService } from './AIService.js';

export class JSDocValidator {
    private parserOptions: ParserOptions = {
        sourceType: 'module',
        ecmaVersion: 2020,
        ecmaFeatures: {
            jsx: true
        },
        range: true,
        loc: true,
        tokens: true,
        comment: true
    };

    constructor(private aiService: AIService) {}

    /**
     * Validates and fixes JSDoc comments in TypeScript code
     */
    public async validateAndFixJSDoc(fileName: string, code: string, originalComment: string): Promise<string> {
        // First try parsing with the original comment
        if (this.isValidTypeScript(code)) {
            return originalComment;
        }

        // Try fixing common JSDoc issues
        const fixedComment = this.fixCommonJSDocIssues(originalComment);
        const codeWithFixedComment = code.replace(originalComment, fixedComment);

        if (this.isValidTypeScript(codeWithFixedComment)) {
            console.log(`✓ JSDoc comment in ${fileName} was fixed using regex patterns`);
            return fixedComment;
        } else {
            console.log(`❌JSDoc comment in ${fileName} regex patterns failed, making AI call for help`);
        }

        // If still invalid, try regenerating with AI
        try {
            const regeneratedComment = await this.regenerateJSDoc(code);
            const codeWithRegeneratedComment = code.replace(originalComment, regeneratedComment);

            if (this.isValidTypeScript(codeWithRegeneratedComment)) {
                console.log(`✓ JSDoc comment in ${fileName} was regenerated using AI`);
                return regeneratedComment;
            }
        } catch (error) {
            console.error(`Error during AI regeneration for ${fileName}:`, error);
        }

        // Instead of throwing, log the issue and return original
        console.warn(`⚠️ HUMAN INTERVENTION NEEDED - Invalid JSDoc in ${fileName}`);
        console.warn('Original comment:', originalComment);
        return originalComment;
    }

    /**
     * Checks if the TypeScript code is valid
     */
    private isValidTypeScript(code: string): boolean {
        try {
            parse(code, this.parserOptions);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Fixes common JSDoc formatting issues
     */
    private fixCommonJSDocIssues(comment: string): string {
        // First remove any backtick code block markers
        comment = comment.replace(/^```[\s\S]*?\n/, ''); // Remove opening code block
        comment = comment.replace(/\n```$/, '');         // Remove closing code block

        const fixes = [
            // Fix opening format
            [/\/\*\*?(?!\*)/, '/**'],  // Ensure proper opening

            // Fix body asterisks and spacing
            [/\*{3,}/g, '**'],         // Remove excessive asterisks in body
            [/\*(?!\s|\*|\/)/g, '* '], // Add space after single asterisk
            [/^(\s*)\*\s\s+/gm, '$1* '], // Remove multiple spaces after asterisk

            // Fix multi-line issues (from bash script insights)
            [/\*\/\s*\n\s*\*\*\//g, '*/'], // Remove stray closing after proper closing
            [/\n\s*\*\s*\n\s*\*\//g, '\n */'], // Fix empty line before closing

            // Fix closing format
            [/\*+\//g, '*/'],          // Fix multiple asterisks in closing
            [/(?<!\s)\*\//g, ' */'],   // Ensure space before closing
            [/\*\/\s+\*\//g, '*/'],    // Remove multiple closings

            // Fix indentation
            [/\n\*/g, '\n *'],         // Ensure asterisk alignment
            [/^\s*\*\s*$/gm, ' *'],    // Fix empty comment lines

            // Remove trailing spaces
            [/\s+$/gm, ''],

            // Ensure proper spacing around parameter/return tags
            [/@(param|returns?|throws?|example)\s{2,}/g, '@$1 '],

            // Fix type definition spacing
            [/\{(\w+)\}/g, '{ $1 }'],  // Add spaces inside type braces

            // Normalize newlines
            [/\r\n/g, '\n'],
        ];

        let fixed = comment;
        for (const [pattern, replacement] of fixes) {
            fixed = fixed.replace(pattern, replacement as string);
        }

        return fixed;
    }

    /**
     * Regenerates JSDoc using AI with stronger constraints
     */
    private async regenerateJSDoc(code: string): Promise<string> {
        const prompt = `Fix the following JSDoc comment to be syntactically valid.
        Ensure proper formatting:
        - Start with /**
        - Each line should start with a single *
        - End with */
        - No extra asterisks
        - Space after each asterisk
        - Space before closing tag

        Code:
        ${code}

        Return ONLY the fixed JSDoc comment, nothing else.`;

        return await this.aiService.generateComment(prompt);
    }
}