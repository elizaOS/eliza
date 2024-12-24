import { DirectoryTraversal } from './DirectoryTraversal.js';
import { TypeScriptParser } from './TypeScriptParser.js';
import { JsDocAnalyzer } from './JsDocAnalyzer.js';
import { JsDocGenerator } from './JsDocGenerator.js';
import type { TSESTree } from '@typescript-eslint/types';
import { ASTQueueItem, FullModeFileChange, PrModeFileChange } from './types/index.js';
import { GitManager } from './GitManager.js';
import fs from 'fs';
import { Configuration } from './Configuration.js';
import path from 'path';
import { AIService } from './AIService.js';

/**
 * Class representing a Documentation Generator.
 *
 */
export class DocumentationGenerator {
    public missingJsDocQueue: ASTQueueItem[] = [];
    public existingJsDocQueue: ASTQueueItem[] = [];
    private hasChanges: boolean = false;
    private fileContents: Map<string, string> = new Map();
    private branchName: string = '';
    private fileOffsets: Map<string, number> = new Map();

    /**
     * Constructor for initializing the object with necessary dependencies.
     *
     * @param {DirectoryTraversal} directoryTraversal - Instance of DirectoryTraversal class.
     * @param {TypeScriptParser} typeScriptParser - Instance of TypeScriptParser class.
     * @param {JsDocAnalyzer} jsDocAnalyzer - Instance of JsDocAnalyzer class.
     * @param {JsDocGenerator} jsDocGenerator - Instance of JsDocGenerator class.
     * @param {GitManager} gitManager - Instance of GitManager class.
     * @param {Configuration} configuration - Instance of Configuration class.
     * @param {AIService} aiService - Instance of AIService class.
     */

    constructor(
        public directoryTraversal: DirectoryTraversal,
        public typeScriptParser: TypeScriptParser,
        public jsDocAnalyzer: JsDocAnalyzer,
        public jsDocGenerator: JsDocGenerator,
        public gitManager: GitManager,
        public configuration: Configuration,
        public aiService: AIService
    ) { }

    /**
     * Asynchronously generates JSDoc comments for the TypeScript files based on the given pull request number or full mode.
     *
     * @param pullNumber - Optional. The pull request number to generate JSDoc comments for.
     * @returns A promise that resolves once the JSDoc generation process is completed.
     */
    public async generate(pullNumber?: number): Promise<void> {
        let fileChanges: PrModeFileChange[] | FullModeFileChange[] = [];
        this.fileOffsets.clear();

        if (pullNumber) {
            const prFiles = await this.gitManager.getFilesInPullRequest(pullNumber);
            fileChanges = prFiles.filter(file => {
                // Convert PR file path (which is repo-relative) to absolute path
                const absolutePath = this.configuration.toAbsolutePath(file.filename);

                // Check if file is in target directory
                const isInTargetDir = absolutePath.startsWith(this.configuration.absolutePath);

                // Get path relative to target directory for exclusion checking
                const relativeToTarget = path.relative(
                    this.configuration.absolutePath,
                    absolutePath
                );

                // Check exclusions
                const isExcluded =
                    // Check excluded directories
                    this.configuration.excludedDirectories.some(dir =>
                        relativeToTarget.split(path.sep)[0] === dir
                    ) ||
                    // Check excluded files
                    this.configuration.excludedFiles.some(excludedFile =>
                        path.basename(absolutePath) === excludedFile
                    );

                return isInTargetDir && !isExcluded;
            });
        } else {
            const typeScriptFiles = this.directoryTraversal.traverse();
            fileChanges = typeScriptFiles.map((file) => ({
                filename: this.configuration.toRelativePath(file),
                status: 'modified',
            }));
        }

        // Process each TypeScript file
        for (const fileChange of fileChanges) {
            if (fileChange.status === 'deleted') continue;

            const filePath = this.configuration.toAbsolutePath(fileChange.filename);
            console.log(`Processing file: ${filePath}`, 'resetting file offsets', 'from ', this.fileOffsets.get(filePath), 'to 0');
            this.fileOffsets.set(filePath, 0);

            // Load and store file content
            if (fileChange.status === 'added' && 'contents_url' in fileChange) {
                console.log('Getting file content from GitHub API');
                const fileContent = await this.getFileContent(fileChange.contents_url);
                this.fileContents.set(filePath, fileContent);
            } else {
                console.log('Getting file content from local file system');
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                this.fileContents.set(filePath, fileContent);
            }

            const ast = this.typeScriptParser.parse(filePath);
            if (!ast || !ast.body) {
                console.log('Invalid AST found for file', filePath);
                continue;
            }

            this.jsDocAnalyzer.analyze(ast);

            // Process each node in the file
            for (const node of ast.body) {
                this.processNode(node, filePath, ast);
            }
        }

        // Process nodes that need JSDoc
        if (this.missingJsDocQueue.length > 0) {
            this.branchName = `docs-update-${pullNumber || 'full'}-${Date.now()}`;
            await this.gitManager.createBranch(this.branchName, this.configuration.branch);

            // Process each node
            for (const queueItem of this.missingJsDocQueue) {
                let comment = '';
                if (queueItem.className !== undefined) {
                    comment = await this.jsDocGenerator.generateClassComment(queueItem);
                } else {
                    comment = await this.jsDocGenerator.generateComment(queueItem);
                }
                await this.updateFileWithJSDoc(queueItem.filePath, comment, queueItem.startLine);
                this.hasChanges = true;
            }

            // Commit changes if any updates were made
            if (this.hasChanges && this.branchName) {
                for (const [filePath, content] of this.fileContents) {
                    await this.gitManager.commitFile(
                        this.branchName,
                        this.configuration.toRelativePath(filePath),
                        content,
                        `docs: Add JSDoc documentation to ${path.basename(filePath)}`
                    );
                }

                const prContent = await this.generatePRContent(pullNumber);
                await this.gitManager.createPullRequest({
                    title: prContent.title,
                    body: prContent.body,
                    head: this.branchName,
                    base: this.configuration.branch,
                    labels: ['documentation', 'automated-pr'],
                    reviewers: this.configuration.pullRequestReviewers || []
                });
            }
        }
    }

    /**
     * Processes a single AST node and its children for JSDoc documentation
     * @param node - The AST node to process
     * @param filePath - Path to the source file
     * @param ast - The complete AST
     */
    private processNode(node: TSESTree.Node, filePath: string, ast: TSESTree.Program): void {
        if (!this.jsDocAnalyzer.shouldHaveJSDoc(node)) return;

        // Process the main node
        const jsDocComment = this.jsDocAnalyzer.getJSDocComment(node, ast.comments || []);
        const queueItem = this.jsDocAnalyzer.createQueueItem(
            node,
            filePath,
            this.getNodeCode(filePath, node)
        );

        if (jsDocComment) {
            queueItem.jsDoc = jsDocComment;
            this.existingJsDocQueue.push(queueItem);
        } else {
            this.missingJsDocQueue.push(queueItem);
        }

        // Process any documentable children (like class methods)
        const children = this.jsDocAnalyzer.getDocumentableChildren(node);
        for (const child of children) {
            const childJsDocComment = this.jsDocAnalyzer.getJSDocComment(child, ast.comments || []);
            const childQueueItem = this.jsDocAnalyzer.createQueueItem(
                child,
                filePath,
                this.getNodeCode(filePath, child)
            );

            if (childJsDocComment) {
                childQueueItem.jsDoc = childJsDocComment;
                this.existingJsDocQueue.push(childQueueItem);
            } else {
                this.missingJsDocQueue.push(childQueueItem);
            }
        }
    }

    /**
     * Updates a file with JSDoc at a specific position.
     * @param {string} filePath - The path to the file to update.
     * @param {string} jsDoc - The JSDoc to insert into the file.
     * @param {number} insertLine - The line number where the JSDoc should be inserted.
     * @returns {Promise<void>} - A Promise that resolves once the file has been updated.
     */
    private async updateFileWithJSDoc(filePath: string, jsDoc: string, insertLine: number): Promise<void> {
        const content = this.fileContents.get(filePath) || '';
        const lines = content.split('\n');
        const currentOffset = this.fileOffsets.get(filePath) || 0;
        const newLines = (jsDoc.match(/\n/g) || []).length + 1;
        const adjustedLine = insertLine + currentOffset;

        lines.splice(adjustedLine - 1, 0, jsDoc);
        this.fileOffsets.set(filePath, currentOffset + newLines);
        this.fileContents.set(filePath, lines.join('\n'));
    }

    /**
     * Retrieves the code of a specific node from a given file.
     *
     * @param {string} filePath - The path to the file containing the node.
     * @param {TSESTree.Node} node - The node to extract the code from.
     * @returns {string} The code belonging to the specified node.
     */
    public getNodeCode(filePath: string, node: TSESTree.Node): string {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split('\n');
        const startLine = node.loc?.start.line || 0;
        const endLine = node.loc?.end.line || 0;
        return lines.slice(startLine - 1, endLine).join('\n');
    }

    /**
     * Retrieves the content of a file from the provided URL.
     *
     * @param {string} contentsUrl - The URL of the file contents
     * @returns {Promise<string>} The content of the file as a string
     */
    private async getFileContent(contentsUrl: string): Promise<string> {
        try {
            const response = await fetch(contentsUrl);
            const data = await response.json();
            return Buffer.from(data.content, 'base64').toString('utf-8');
        } catch (error) {
            console.error('Error fetching file content from GitHub API, ensure the PR has been merged');
            return '';
        }
    }

    /**
     * Asynchronously generates a pull request title and description for adding JSDoc documentation.
     * @param {number} [pullNumber] - Optional pull request number that the JSDoc documentation is related to.
     * @returns {Promise<{ title: string; body: string }>} - A promise that resolves to an object with a title and body for the pull request.
     */
    private async generatePRContent(pullNumber?: number): Promise<{ title: string; body: string }> {
        const modifiedFiles = Array.from(this.fileContents.keys());
        const filesContext = modifiedFiles.map(file => `- ${file}`).join('\n');

        const prompt = `Generate a pull request title and description for adding JSDoc documentation.
            Context:
            - ${modifiedFiles.length} files were modified
            - Files modified:\n${filesContext}
            - This is ${pullNumber ? `related to PR #${pullNumber}` : 'a full repository documentation update'}
            - This is an automated PR for adding JSDoc documentation

            Generate both a title and description. The description should be detailed and include:
            1. A clear summary of changes
            2. Summary of modified files
            3. Instructions for reviewers

            Format the response as a JSON object with 'title' and 'body' fields.`;

        const response = await this.aiService.generateComment(prompt);
        try {
            const content = JSON.parse(response);
            return {
                title: content.title,
                body: content.body
            };
        } catch (error) {
            console.error('Error parsing AI response for PR content generation, using default values');
            return {
                title: `docs: Add JSDoc documentation${pullNumber ? ` for PR #${pullNumber}` : ''}`,
                body: this.generateDefaultPRBody()
            };
        }
    }

    /**
     * Generates the default pull request body for adding JSDoc documentation to TypeScript files.
     *
     * @returns {string} The default pull request body containing information about the changes made.
     */
    private generateDefaultPRBody(): string {
        const changes = Array.from(this.fileContents.keys())
            .map(filePath => `- Added JSDoc documentation to \`${filePath}\``)
            .join('\n');

        return `## 📝 Documentation Updates
        This PR adds JSDoc documentation to TypeScript files that were missing proper documentation.

        ### 🔍 Changes Made:
        ${changes}

        ### 🤖 Generated by Documentation Bot
        This is an automated PR created by the documentation generator tool.`;
    }
}