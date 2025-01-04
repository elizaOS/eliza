// Configuration.ts
import * as fs from 'fs';
import * as yaml from 'yaml';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Repository } from './types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Gets the repository root path by going up two levels from the current file
 * This assumes the code is in src/ directory of the package
 */
const getRepoRoot = () => path.resolve(__dirname, '../../../');

interface ConfigurationData {
    rootDirectory: {
        absolute: string;  // Full path from filesystem root
        relative: string;  // Path relative to repository root
    };
    excludedDirectories: string[];
    repository: Repository;
    commitMessage: string;
    pullRequestTitle: string;
    pullRequestDescription: string;
    pullRequestLabels: string[];
    pullRequestReviewers: string[];
    excludedFiles: string[];
    generateJsDoc: boolean;
    generateReadme: boolean;
    language: string;
}

/**
 * Represents a configuration object that holds various settings for a project.
 * Handles both absolute and relative paths for different operations.
 */
export class Configuration implements Omit<ConfigurationData, 'rootDirectory'> {
    private _rootDirectory!: ConfigurationData['rootDirectory'];
    private readonly repoRoot: string;
    private _branch: string = 'develop';
    private _language: string = 'English';
    private _generateJsDoc: boolean = true;
    private _generateReadme: boolean = true;

    public excludedDirectories: string[] = [];
    public repository: Repository = {
        owner: 'elizaOS',
        name: 'eliza',
        pullNumber: undefined
    };
    public commitMessage: string = 'Generated JSDoc comments';
    public pullRequestTitle: string = 'JSDoc Generation';
    public pullRequestDescription: string = 'Automated JSDoc generation for the codebase';
    public pullRequestLabels: string[] = ['documentation', 'automated-pr'];
    public pullRequestReviewers: string[] = [];
    public excludedFiles: string[] = ["index.d.ts"];

    constructor() {
        this.repoRoot = getRepoRoot();
        this.loadConfiguration();
    }

    get language(): string {
        return this._language;
    }

    set language(value: string) {
        this._language = value;
    }

    get generateJsDoc(): boolean {
        return this._generateJsDoc;
    }

    get generateReadme(): boolean {
        return this._generateReadme;
    }

    get rootDirectory(): ConfigurationData['rootDirectory'] {
        return this._rootDirectory;
    }

    get absolutePath(): string {
        return this._rootDirectory.absolute;
    }

    get relativePath(): string {
        return this._rootDirectory.relative;
    }

    public toRelativePath(absolutePath: string): string {
        return path.relative(this.repoRoot, absolutePath);
    }

    public toAbsolutePath(relativePath: string): string {
        return path.resolve(this.repoRoot, relativePath);
    }

    get branch(): string {
        return this._branch;
    }

    set branch(value: string) {
        this._branch = value;
    }

    private loadConfiguration(): void {
        // First try to get from environment variables
        this._language = process.env.INPUT_LANGUAGE || 'English';
        console.log('Using language:', this._language);
        const rootDirectory = process.env.INPUT_ROOT_DIRECTORY;
        this._generateJsDoc = process.env.INPUT_JSDOC
            ? process.env.INPUT_JSDOC.toUpperCase() === 'T'
            : true; // Default from workflow
        this._generateReadme = process.env.INPUT_README
            ? process.env.INPUT_README.toUpperCase() === 'T'
            : true;  // Default from workflow

        console.log('Documentation flags:', {
            generateJsDoc: this._generateJsDoc,
            generateReadme: this._generateReadme
        });

        let inputs;

        console.log('Environment variables:', {
            rootDirectory: process.env.INPUT_ROOT_DIRECTORY,
            pullNumber: process.env.INPUT_PULL_NUMBER,
            excludedDirs: process.env.INPUT_EXCLUDED_DIRECTORIES,
            reviewers: process.env.INPUT_REVIEWERS
        });

        if (rootDirectory) {
            console.log('Using root directory from environment variable:', rootDirectory);
            this._rootDirectory = {
                absolute: path.resolve(this.repoRoot, rootDirectory),
                relative: rootDirectory.replace(/^\/+/, '')
            };
        } else {
            console.log('Falling back to workflow file configuration');
            const workflowPath = join(this.repoRoot, '.github/workflows/jsdoc-automation.yml');
            if (!fs.existsSync(workflowPath)) {
                throw new Error(`Workflow file not found at ${workflowPath}`);
            }
            const workflowContent = fs.readFileSync(workflowPath, 'utf8');
            const workflow = yaml.parse(workflowContent);
            const inputs = workflow.on.workflow_dispatch.inputs;

            if (!inputs?.root_directory?.default) {
                throw new Error('No root directory default found in workflow configuration');
            }

            const targetDir = inputs.root_directory.default;
            console.log('Using default root directory from workflow:', targetDir);
            this._rootDirectory = {
                absolute: path.resolve(this.repoRoot, targetDir),
                relative: targetDir.replace(/^\/+/, '')
            };
        }

        console.log('Final root directory configuration:', {
            absolute: this._rootDirectory.absolute,
            relative: this._rootDirectory.relative
        });

        // Handle other inputs
        if (process.env.INPUT_PULL_NUMBER) {
            console.log('Setting pull number from env:', process.env.INPUT_PULL_NUMBER);
            this.repository.pullNumber = parseInt(process.env.INPUT_PULL_NUMBER);
        }

        this.excludedDirectories = this.parseCommaSeparatedInput(
            process.env.INPUT_EXCLUDED_DIRECTORIES,
            ['node_modules', 'dist', 'test']
        );

        this.pullRequestReviewers = this.parseCommaSeparatedInput(
            process.env.INPUT_REVIEWERS,
            []
        );

        this._branch = process.env.INPUT_BRANCH || 'develop';
        console.log('Using branch:', this._branch);
    }

    private parseCommaSeparatedInput(input: string | undefined, defaultValue: string[]): string[] {
        if (!input) return defaultValue;
        return input
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
    }
}