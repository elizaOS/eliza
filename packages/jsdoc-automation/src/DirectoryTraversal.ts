import * as fs from 'fs';
import * as path from 'path';
import { Configuration } from './Configuration.js';



/**
 * DirectoryTraversal class for traversing through directories and files.
 * @class DirectoryTraversal
 */
export class DirectoryTraversal {
    /**
     * Directories that should always be excluded from scanning,
     * regardless of configuration
     */
    private static readonly FORCED_EXCLUDED_DIRS = [
        'node_modules',
        '.git',
        'dist',
        'build',
        'coverage',
        '.next',
        '.nuxt',
        '.cache',
        'tmp',
        'temp',
        '.turbo',
        '.husky',
        '.github',
        '.vscode',
        'public',
        'static'
    ];

    /**
     * Constructor for directory traversal
     * @param {Configuration} config - Configuration object containing paths and exclusions
     * @param {string[]} [prFiles=[]] - PR files to process
     */
    constructor(
        private config: Configuration,
        public prFiles: string[] = []
    ) {}

    /**
     * Gets the absolute path for a file
     */
    public getAbsolutePath(filePath: string): string {
        return this.config.toAbsolutePath(filePath);
    }

    /**
     * Gets the repository-relative path for a file
     */
    public getRelativePath(filePath: string): string {
        return this.config.toRelativePath(filePath);
    }

    /**
     * Traverses the directory based on PRFiles or all files in the root directory.
     * If PRFiles are detected, processes only files from the PR.
     * Otherwise, scans all files in the root directory for TypeScript files.
     *
     *
     * @returns An array of string containing the files to process.
     */
    public traverse(): string[] {
        if (this.prFiles.length > 0) {
            console.log('Detected PR Files:', this.prFiles);

            // PR files are already relative to repo root, filter and convert to absolute paths
            const files = this.prFiles
                .filter((file) => {
                    // Convert PR file (repo-relative) to absolute path
                    const absolutePath = this.config.toAbsolutePath(file);

                    // Check if the file is within our target directory
                    const isInTargetDir = absolutePath.startsWith(this.config.absolutePath);

                    return (
                        isInTargetDir &&
                        fs.existsSync(absolutePath) &&
                        !this.isExcluded(absolutePath) &&
                        path.extname(file) === '.ts'
                    );
                })
                .map(file => this.config.toAbsolutePath(file));

            console.log('Files to process:', files);
            return files;
        } else {
            console.log('No PR Files Detected, Scanning all files in root directory');
            const typeScriptFiles: string[] = [];

            const traverseDirectory = (currentDirectory: string) => {
                const files = fs.readdirSync(currentDirectory);

                files.forEach((file) => {
                    const filePath = path.join(currentDirectory, file);
                    const stats = fs.statSync(filePath);

                    if (stats.isDirectory()) {
                        if (!this.isExcluded(filePath)) {
                            traverseDirectory(filePath);
                        }
                    } else if (stats.isFile() && !this.isExcluded(filePath)) {
                        if (path.extname(file) === '.ts') {
                            typeScriptFiles.push(filePath);
                        }
                    }
                });
            };

            traverseDirectory(this.config.absolutePath);
            return typeScriptFiles;
        }
    }

    /**
     * Check if a file path is excluded based on the excluded directories and files
     */
    private isExcluded(absolutePath: string): boolean {
        // Get path relative to the target directory for exclusion checking
        const relativeToTarget = path.relative(this.config.absolutePath, absolutePath);

        // First check forced excluded directories - these are always excluded
        const isInForcedExcludedDir = DirectoryTraversal.FORCED_EXCLUDED_DIRS.some(dir =>
            absolutePath.includes(`${path.sep}${dir}${path.sep}`) ||
            absolutePath.includes(`${path.sep}${dir}`) ||
            absolutePath.startsWith(`${dir}${path.sep}`)
        );

        if (isInForcedExcludedDir) {
            return true;
        }

        // Check if path is in excluded directory
        const isExcludedDir = this.config.excludedDirectories.some(dir =>
            relativeToTarget.split(path.sep)[0] === dir
        );

        // Check if file is excluded
        const isExcludedFile = this.config.excludedFiles.some(file =>
            path.basename(absolutePath) === file
        );

        return isExcludedDir || isExcludedFile;
    }
}