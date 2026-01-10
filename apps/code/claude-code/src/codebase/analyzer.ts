/**
 * Codebase Analyzer
 * 
 * Provides utilities for analyzing and understanding code structure,
 * dependencies, and metrics about a codebase.
 */

import path from 'path';
import fs from 'fs/promises';
import { fileExists, readTextFile, findFiles } from '../fs/operations.js';
import { logger } from '../utils/logger.js';
import { createUserError } from '../errors/formatter.js';
import { ErrorCategory } from '../errors/types.js';

/**
 * File info with language detection and stats
 */
export interface FileInfo {
  /**
   * File path relative to project root
   */
  path: string;
  
  /**
   * File extension
   */
  extension: string;
  
  /**
   * Detected language
   */
  language: string;
  
  /**
   * File size in bytes
   */
  size: number;
  
  /**
   * Line count
   */
  lineCount: number;
  
  /**
   * Last modified timestamp
   */
  lastModified: Date;
}

/**
 * Code dependency information
 */
export interface DependencyInfo {
  /**
   * Module/package name
   */
  name: string;
  
  /**
   * Type of dependency (import, require, etc.)
   */
  type: string;
  
  /**
   * Source file path
   */
  source: string;
  
  /**
   * Import path
   */
  importPath: string;
  
  /**
   * Whether it's an external dependency
   */
  isExternal: boolean;
}

/**
 * Project structure information
 */
export interface ProjectStructure {
  /**
   * Root directory
   */
  root: string;
  
  /**
   * Total file count
   */
  totalFiles: number;
  
  /**
   * Files by language
   */
  filesByLanguage: Record<string, number>;
  
  /**
   * Total lines of code
   */
  totalLinesOfCode: number;
  
  /**
   * Files organized by directory
   */
  directories: Record<string, string[]>;
  
  /**
   * Dependencies identified in the project
   */
  dependencies: DependencyInfo[];
}

/**
 * File pattern to ignore during analysis
 */
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  'dist',
  'build',
  '.git',
  '.vscode',
  '.idea',
  'coverage',
  '*.min.js',
  '*.bundle.js',
  '*.map'
];

/**
 * Language detection by file extension
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript (React)',
  js: 'JavaScript',
  jsx: 'JavaScript (React)',
  py: 'Python',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  cs: 'C#',
  go: 'Go',
  rs: 'Rust',
  php: 'PHP',
  rb: 'Ruby',
  swift: 'Swift',
  kt: 'Kotlin',
  scala: 'Scala',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  json: 'JSON',
  md: 'Markdown',
  yml: 'YAML',
  yaml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  sh: 'Shell',
  bat: 'Batch',
  ps1: 'PowerShell'
};

/**
 * Analyze a codebase
 */
export async function analyzeCodebase(
  directory: string,
  options: {
    ignorePatterns?: string[];
    maxFiles?: number;
    maxSizePerFile?: number; // in bytes
  } = {}
): Promise<ProjectStructure> {
  logger.info(`Analyzing codebase in directory: ${directory}`);
  
  const {
    ignorePatterns = DEFAULT_IGNORE_PATTERNS,
    maxFiles = 1000,
    maxSizePerFile = 1024 * 1024 // 1MB
  } = options;
  
  // Check if directory exists
  if (!await fileExists(directory)) {
    throw createUserError(`Directory does not exist: ${directory}`, {
      category: ErrorCategory.FILE_NOT_FOUND,
      resolution: 'Please provide a valid directory path.'
    });
  }
  
  // Initial project structure
  const projectStructure: ProjectStructure = {
    root: directory,
    totalFiles: 0,
    filesByLanguage: {},
    totalLinesOfCode: 0,
    directories: {},
    dependencies: []
  };
  
  // Pattern for ignore patterns
  const ignoreRegexes = ignorePatterns.map(pattern => {
    // Convert glob pattern to regex pattern
    return new RegExp(
      pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    );
  });
  
  // Find all files recursively
  let allFiles: string[] = [];
  try {
    allFiles = await findFiles(directory, { 
      recursive: true,
      includeDirectories: false
    });
    
    // Filter out ignored files
    allFiles = allFiles.filter(file => {
      const relativePath = path.relative(directory, file);
      return !ignoreRegexes.some(regex => regex.test(relativePath));
    });
    
    // Cap file count if needed
    if (allFiles.length > maxFiles) {
      logger.warn(`Codebase has too many files (${allFiles.length}), limiting to ${maxFiles} files`);
      allFiles = allFiles.slice(0, maxFiles);
    }
  } catch (error) {
    logger.error('Failed to scan directory for files', error);
    throw createUserError(`Failed to scan codebase: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM
    });
  }
  
  // Update total files count
  projectStructure.totalFiles = allFiles.length;
  
  // Analyze each file
  let processedFiles = 0;
  let skippedFiles = 0;
  
  for (const file of allFiles) {
    try {
      // Get file stats
      const stats = await fs.stat(file);
      
      // Skip if file is too large
      if (stats.size > maxSizePerFile) {
        logger.debug(`Skipping file (too large): ${file} (${formatFileSize(stats.size)})`);
        skippedFiles++;
        continue;
      }
      
      // Get relative path
      const relativePath = path.relative(directory, file);
      
      // Get directory
      const dirPath = path.dirname(relativePath);
      if (!projectStructure.directories[dirPath]) {
        projectStructure.directories[dirPath] = [];
      }
      projectStructure.directories[dirPath].push(relativePath);
      
      // Get file extension and language
      const extension = path.extname(file).slice(1).toLowerCase();
      const language = EXTENSION_TO_LANGUAGE[extension] || 'Other';
      
      // Update language stats
      projectStructure.filesByLanguage[language] = (projectStructure.filesByLanguage[language] || 0) + 1;
      
      // Read file and count lines
      const content = await readTextFile(file);
      const lineCount = content.split('\n').length;
      projectStructure.totalLinesOfCode += lineCount;
      
      // Find dependencies
      const dependencies = findDependencies(content, relativePath, extension);
      projectStructure.dependencies.push(...dependencies);
      
      // Log progress periodically
      processedFiles++;
      if (processedFiles % 50 === 0) {
        logger.debug(`Analyzed ${processedFiles} files...`);
      }
    } catch (error) {
      logger.warn(`Failed to analyze file: ${file}`, error);
      skippedFiles++;
    }
  }
  
  // Log results
  logger.info(`Codebase analysis complete: ${processedFiles} files analyzed, ${skippedFiles} files skipped`);
  logger.debug('Analysis summary', {
    totalFiles: projectStructure.totalFiles,
    totalLinesOfCode: projectStructure.totalLinesOfCode,
    languages: Object.keys(projectStructure.filesByLanguage).length,
    directories: Object.keys(projectStructure.directories).length,
    dependencies: projectStructure.dependencies.length
  });
  
  return projectStructure;
}

/**
 * Format file size in a human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}

/**
 * Find dependencies in a file
 */
function findDependencies(
  content: string,
  filePath: string,
  extension: string
): DependencyInfo[] {
  const dependencies: DependencyInfo[] = [];
  
  // Skip binary files or non-code files
  if (!content || !isCodeFile(extension)) {
    return dependencies;
  }
  
  try {
    // JavaScript/TypeScript imports
    if (['js', 'jsx', 'ts', 'tsx'].includes(extension)) {
      // Find ES module imports
      const esImportRegex = /import\s+(?:[\w\s{},*]*\s+from\s+)?['"]([^'"]+)['"]/g;
      let match;
      while ((match = esImportRegex.exec(content)) !== null) {
        const importPath = match[1];
        dependencies.push({
          name: getPackageName(importPath),
          type: 'import',
          source: filePath,
          importPath,
          isExternal: isExternalDependency(importPath)
        });
      }
      
      // Find require statements
      const requireRegex = /(?:const|let|var)\s+(?:[\w\s{},*]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = requireRegex.exec(content)) !== null) {
        const importPath = match[1];
        dependencies.push({
          name: getPackageName(importPath),
          type: 'require',
          source: filePath,
          importPath,
          isExternal: isExternalDependency(importPath)
        });
      }
    }
    
    // Python imports
    else if (extension === 'py') {
      // Find import statements
      const importRegex = /^\s*import\s+(\S+)|\s*from\s+(\S+)\s+import/gm;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1] || match[2];
        if (importPath) {
          dependencies.push({
            name: importPath.split('.')[0],
            type: 'import',
            source: filePath,
            importPath,
            isExternal: isExternalPythonModule(importPath)
          });
        }
      }
    }
    
    // Java imports
    else if (extension === 'java') {
      const importRegex = /^\s*import\s+([^;]+);/gm;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        dependencies.push({
          name: importPath.split('.')[0],
          type: 'import',
          source: filePath,
          importPath,
          isExternal: true // Consider all imports as external for Java
        });
      }
    }
    
    // Ruby requires
    else if (extension === 'rb') {
      const requireRegex = /^\s*require\s+['"]([^'"]+)['"]/gm;
      let match;
      while ((match = requireRegex.exec(content)) !== null) {
        const importPath = match[1];
        dependencies.push({
          name: importPath,
          type: 'require',
          source: filePath,
          importPath,
          isExternal: true // Consider all requires as external for Ruby
        });
      }
    }
  } catch (error) {
    logger.warn(`Failed to parse dependencies in ${filePath}`, error);
  }
  
  return dependencies;
}

/**
 * Check if a file is a code file based on extension
 */
function isCodeFile(extension: string): boolean {
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'cs',
    'go', 'rs', 'php', 'rb', 'swift', 'kt', 'scala'
  ];
  return codeExtensions.includes(extension);
}

/**
 * Get package name from import path
 */
function getPackageName(importPath: string): string {
  // Relative imports don't have a package name
  if (importPath.startsWith('.') || importPath.startsWith('/')) {
    return 'internal';
  }
  
  // Handle scoped packages (@org/pkg)
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  }
  
  // Regular packages (return first path segment)
  return importPath.split('/')[0];
}

/**
 * Check if import is an external dependency
 */
function isExternalDependency(importPath: string): boolean {
  // Local imports start with ./ or ../
  return !(importPath.startsWith('.') || importPath.startsWith('/'));
}

/**
 * Check if a Python module is external
 */
function isExternalPythonModule(importPath: string): boolean {
  // Common standard library modules in Python
  const stdlibModules = [
    'os', 'sys', 're', 'math', 'datetime', 'time', 'random',
    'json', 'csv', 'collections', 'itertools', 'functools',
    'pathlib', 'shutil', 'glob', 'pickle', 'urllib', 'http',
    'logging', 'argparse', 'unittest', 'subprocess', 'threading',
    'multiprocessing', 'typing', 'enum', 'io', 'tempfile'
  ];
  
  // Consider it external if it's not in standard library
  // and doesn't look like a relative import
  const moduleName = importPath.split('.')[0];
  return !stdlibModules.includes(moduleName) && !importPath.startsWith('.');
}

/**
 * Analyze project dependencies from package files
 */
export async function analyzeProjectDependencies(directory: string): Promise<Record<string, string>> {
  const dependencies: Record<string, string> = {};
  
  try {
    // Check for package.json
    const packageJsonPath = path.join(directory, 'package.json');
    if (await fileExists(packageJsonPath)) {
      const packageJson = JSON.parse(await readTextFile(packageJsonPath));
      
      // Add dependencies
      if (packageJson.dependencies) {
        for (const [name, version] of Object.entries(packageJson.dependencies)) {
          dependencies[name] = version as string;
        }
      }
      
      // Add dev dependencies
      if (packageJson.devDependencies) {
        for (const [name, version] of Object.entries(packageJson.devDependencies)) {
          dependencies[`${name} (dev)`] = version as string;
        }
      }
    }
    
    // Check for Python requirements.txt
    const requirementsPath = path.join(directory, 'requirements.txt');
    if (await fileExists(requirementsPath)) {
      const requirements = await readTextFile(requirementsPath);
      
      requirements.split('\n').forEach(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
          const [name, version] = line.split('==');
          if (name) {
            dependencies[name.trim()] = version ? version.trim() : 'latest';
          }
        }
      });
    }
    
    // Check for Gemfile for Ruby
    const gemfilePath = path.join(directory, 'Gemfile');
    if (await fileExists(gemfilePath)) {
      const gemfile = await readTextFile(gemfilePath);
      
      const gemRegex = /^\s*gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"]\s*)?/gm;
      let match;
      while ((match = gemRegex.exec(gemfile)) !== null) {
        const name = match[1];
        const version = match[2] || 'latest';
        if (name) {
          dependencies[name] = version;
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to analyze project dependencies', error);
  }
  
  return dependencies;
}

/**
 * Find files by content search
 */
export async function findFilesByContent(
  directory: string,
  searchTerm: string,
  options: {
    caseSensitive?: boolean;
    fileExtensions?: string[];
    maxResults?: number;
    ignorePatterns?: string[];
  } = {}
): Promise<Array<{ path: string; line: number; content: string }>> {
  const {
    caseSensitive = false,
    fileExtensions = [],
    maxResults = 100,
    ignorePatterns = DEFAULT_IGNORE_PATTERNS
  } = options;
  
  const results: Array<{ path: string; line: number; content: string }> = [];
  const flags = caseSensitive ? 'g' : 'gi';
  const regex = new RegExp(searchTerm, flags);
  
  const ignoreRegexes = ignorePatterns.map(pattern => {
    return new RegExp(
      pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    );
  });
  
  // Find all files (optionally filtered by extension)
  const allFiles = await findFiles(directory, { recursive: true });
  
  // Filter by file extension and ignore patterns
  const filteredFiles = allFiles.filter(file => {
    const relativePath = path.relative(directory, file);
    
    // Check if file should be ignored
    if (ignoreRegexes.some(regex => regex.test(relativePath))) {
      return false;
    }
    
    // Filter by extension if specified
    if (fileExtensions.length > 0) {
      const ext = path.extname(file).slice(1).toLowerCase();
      return fileExtensions.includes(ext);
    }
    
    return true;
  });
  
  // Search through files for content match
  for (const file of filteredFiles) {
    if (results.length >= maxResults) {
      break;
    }
    
    try {
      const content = await readTextFile(file);
      const lines = content.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (regex.test(line)) {
          results.push({
            path: path.relative(directory, file),
            line: i + 1, // 1-indexed line number
            content: line.trim()
          });
          
          if (results.length >= maxResults) {
            break;
          }
        }
      }
    } catch (error) {
      logger.debug(`Failed to search in file: ${file}`, error);
    }
  }
  
  return results;
}

export default {
  analyzeCodebase,
  analyzeProjectDependencies,
  findFilesByContent
}; 