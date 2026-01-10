/**
 * File Operations Module
 * 
 * Provides utilities for reading, writing, and manipulating files
 * with proper error handling and security considerations.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { createUserError } from '../errors/formatter.js';
import { ErrorCategory } from '../errors/types.js';
import { ErrnoException } from '../utils/types.js';

/**
 * Result of a file operation
 */
interface FileOperationResult {
  success: boolean;
  error?: Error;
  path?: string;
  content?: string;
  created?: boolean;
}

/**
 * File Operations Manager
 */
class FileOperationsManager {
  private config: any;
  private workspacePath: string;

  /**
   * Create a new file operations manager
   */
  constructor(config: any) {
    this.config = config;
    this.workspacePath = config.workspacePath || process.cwd();
    
    logger.debug('File operations manager created', {
      workspacePath: this.workspacePath
    });
  }

  /**
   * Initialize file operations
   */
  async initialize(): Promise<void> {
    logger.info('Initializing file operations manager');
    
    try {
      // Verify workspace directory exists
      const stats = await fs.stat(this.workspacePath);
      
      if (!stats.isDirectory()) {
        throw createUserError(`Workspace path is not a directory: ${this.workspacePath}`, {
          category: ErrorCategory.FILE_SYSTEM
        });
      }
      
      logger.info('File operations manager initialized');
    } catch (error) {
      if ((error as ErrnoException).code === 'ENOENT') {
        throw createUserError(`Workspace directory does not exist: ${this.workspacePath}`, {
          category: ErrorCategory.FILE_SYSTEM,
          resolution: 'Please provide a valid workspace path'
        });
      }
      
      logger.error('Failed to initialize file operations manager', error);
      throw createUserError('Failed to initialize file operations', {
        cause: error,
        category: ErrorCategory.FILE_SYSTEM
      });
    }
  }

  /**
   * Get absolute path relative to workspace
   */
  getAbsolutePath(relativePath: string): string {
    // Clean up path to prevent directory traversal attacks
    const normalizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    return path.resolve(this.workspacePath, normalizedPath);
  }

  /**
   * Get relative path from workspace
   */
  getRelativePath(absolutePath: string): string {
    return path.relative(this.workspacePath, absolutePath);
  }

  /**
   * Read a file
   */
  async readFile(filePath: string): Promise<FileOperationResult> {
    const absolutePath = this.getAbsolutePath(filePath);
    
    logger.debug('Reading file', { path: filePath, absolutePath });
    
    try {
      // Verify file exists and is a file
      const stats = await fs.stat(absolutePath);
      
      if (!stats.isFile()) {
        return {
          success: false,
          error: createUserError(`Not a file: ${filePath}`, {
            category: ErrorCategory.FILE_SYSTEM
          })
        };
      }
      
      // Check file size
      const maxSizeBytes = this.config.fileOps?.maxReadSizeBytes || 10 * 1024 * 1024; // 10MB default
      
      if (stats.size > maxSizeBytes) {
        return {
          success: false,
          error: createUserError(`File too large to read: ${filePath} (${stats.size} bytes)`, {
            category: ErrorCategory.FILE_SYSTEM,
            resolution: 'Try reading a smaller file or use a text editor to open this file'
          })
        };
      }
      
      // Read file content
      const content = await fs.readFile(absolutePath, 'utf8');
      
      return {
        success: true,
        path: filePath,
        content
      };
    } catch (error) {
      logger.error(`Error reading file: ${filePath}`, error);
      
      const errnoError = error as ErrnoException;
      
      if (errnoError.code === 'ENOENT') {
        return {
          success: false,
          error: createUserError(`File not found: ${filePath}`, {
            category: ErrorCategory.FILE_SYSTEM,
            resolution: 'Check that the file exists and the path is correct'
          })
        };
      }
      
      if (errnoError.code === 'EACCES') {
        return {
          success: false,
          error: createUserError(`Permission denied reading file: ${filePath}`, {
            category: ErrorCategory.FILE_SYSTEM,
            resolution: 'Check file permissions or try running with elevated privileges'
          })
        };
      }
      
      return {
        success: false,
        error: createUserError(`Failed to read file: ${filePath}`, {
          cause: error,
          category: ErrorCategory.FILE_SYSTEM
        })
      };
    }
  }

  /**
   * Write a file
   */
  async writeFile(filePath: string, content: string, options: { createDirs?: boolean } = {}): Promise<FileOperationResult> {
    const absolutePath = this.getAbsolutePath(filePath);
    
    logger.debug('Writing file', { 
      path: filePath, 
      absolutePath,
      contentLength: content.length,
      createDirs: options.createDirs
    });
    
    try {
      // Check if file exists
      let fileExists = false;
      let isCreating = false;
      
      try {
        const stats = await fs.stat(absolutePath);
        fileExists = stats.isFile();
      } catch (error) {
        const errnoError = error as ErrnoException;
        
        if (errnoError.code === 'ENOENT') {
          isCreating = true;
          
          // Create directories if requested
          if (options.createDirs) {
            const dirPath = path.dirname(absolutePath);
            await fs.mkdir(dirPath, { recursive: true });
          }
        } else {
          throw error;
        }
      }
      
      // Write file content
      await fs.writeFile(absolutePath, content, 'utf8');
      
      return {
        success: true,
        path: filePath,
        created: isCreating
      };
    } catch (error) {
      logger.error(`Error writing file: ${filePath}`, error);
      
      const errnoError = error as ErrnoException;
      
      if (errnoError.code === 'ENOENT') {
        return {
          success: false,
          error: createUserError(`Directory does not exist: ${path.dirname(filePath)}`, {
            category: ErrorCategory.FILE_SYSTEM,
            resolution: 'Use the createDirs option to create parent directories'
          })
        };
      }
      
      if (errnoError.code === 'EACCES') {
        return {
          success: false,
          error: createUserError(`Permission denied writing file: ${filePath}`, {
            category: ErrorCategory.FILE_SYSTEM,
            resolution: 'Check file permissions or try running with elevated privileges'
          })
        };
      }
      
      return {
        success: false,
        error: createUserError(`Failed to write file: ${filePath}`, {
          cause: error,
          category: ErrorCategory.FILE_SYSTEM
        })
      };
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(filePath: string): Promise<FileOperationResult> {
    const absolutePath = this.getAbsolutePath(filePath);
    
    logger.debug('Deleting file', { path: filePath, absolutePath });
    
    try {
      // Verify file exists and is a file
      const stats = await fs.stat(absolutePath);
      
      if (!stats.isFile()) {
        return {
          success: false,
          error: createUserError(`Not a file: ${filePath}`, {
            category: ErrorCategory.FILE_SYSTEM
          })
        };
      }
      
      // Delete file
      await fs.unlink(absolutePath);
      
      return {
        success: true,
        path: filePath
      };
    } catch (error) {
      logger.error(`Error deleting file: ${filePath}`, error);
      
      const errnoError = error as ErrnoException;
      
      if (errnoError.code === 'ENOENT') {
        return {
          success: false,
          error: createUserError(`File not found: ${filePath}`, {
            category: ErrorCategory.FILE_SYSTEM
          })
        };
      }
      
      if (errnoError.code === 'EACCES') {
        return {
          success: false,
          error: createUserError(`Permission denied deleting file: ${filePath}`, {
            category: ErrorCategory.FILE_SYSTEM,
            resolution: 'Check file permissions or try running with elevated privileges'
          })
        };
      }
      
      return {
        success: false,
        error: createUserError(`Failed to delete file: ${filePath}`, {
          cause: error,
          category: ErrorCategory.FILE_SYSTEM
        })
      };
    }
  }

  /**
   * Check if a file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    const absolutePath = this.getAbsolutePath(filePath);
    
    try {
      const stats = await fs.stat(absolutePath);
      return stats.isFile();
    } catch (error) {
      return false;
    }
  }

  /**
   * Create a directory
   */
  async createDirectory(dirPath: string, options: { recursive?: boolean } = {}): Promise<FileOperationResult> {
    const absolutePath = this.getAbsolutePath(dirPath);
    
    logger.debug('Creating directory', { 
      path: dirPath, 
      absolutePath,
      recursive: options.recursive
    });
    
    try {
      // Create directory
      await fs.mkdir(absolutePath, { recursive: options.recursive !== false });
      
      return {
        success: true,
        path: dirPath
      };
    } catch (error) {
      logger.error(`Error creating directory: ${dirPath}`, error);
      
      const errnoError = error as ErrnoException;
      
      if (errnoError.code === 'EEXIST') {
        return {
          success: false,
          error: createUserError(`Directory already exists: ${dirPath}`, {
            category: ErrorCategory.FILE_SYSTEM
          })
        };
      }
      
      if (errnoError.code === 'EACCES') {
        return {
          success: false,
          error: createUserError(`Permission denied creating directory: ${dirPath}`, {
            category: ErrorCategory.FILE_SYSTEM,
            resolution: 'Check file permissions or try running with elevated privileges'
          })
        };
      }
      
      return {
        success: false,
        error: createUserError(`Failed to create directory: ${dirPath}`, {
          cause: error,
          category: ErrorCategory.FILE_SYSTEM
        })
      };
    }
  }

  /**
   * List directory contents
   */
  async listDirectory(dirPath: string): Promise<FileOperationResult & { files?: string[] }> {
    const absolutePath = this.getAbsolutePath(dirPath);
    
    logger.debug('Listing directory', { path: dirPath, absolutePath });
    
    try {
      // Verify directory exists and is a directory
      const stats = await fs.stat(absolutePath);
      
      if (!stats.isDirectory()) {
        return {
          success: false,
          error: createUserError(`Not a directory: ${dirPath}`, {
            category: ErrorCategory.FILE_SYSTEM
          })
        };
      }
      
      // Read directory contents
      const files = await fs.readdir(absolutePath);
      
      return {
        success: true,
        path: dirPath,
        files
      };
    } catch (error) {
      logger.error(`Error listing directory: ${dirPath}`, error);
      
      const errnoError = error as ErrnoException;
      
      if (errnoError.code === 'ENOENT') {
        return {
          success: false,
          error: createUserError(`Directory not found: ${dirPath}`, {
            category: ErrorCategory.FILE_SYSTEM
          })
        };
      }
      
      if (errnoError.code === 'EACCES') {
        return {
          success: false,
          error: createUserError(`Permission denied listing directory: ${dirPath}`, {
            category: ErrorCategory.FILE_SYSTEM,
            resolution: 'Check directory permissions or try running with elevated privileges'
          })
        };
      }
      
      return {
        success: false,
        error: createUserError(`Failed to list directory: ${dirPath}`, {
          cause: error,
          category: ErrorCategory.FILE_SYSTEM
        })
      };
    }
  }

  /**
   * Generate a diff between two strings
   */
  generateDiff(original: string, modified: string): string {
    // A simple line-by-line diff implementation
    // In a real implementation, this would use a proper diff library
    
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    const diff: string[] = [];
    
    let i = 0, j = 0;
    
    while (i < originalLines.length || j < modifiedLines.length) {
      if (i >= originalLines.length) {
        // All remaining lines in modified are additions
        diff.push(`+ ${modifiedLines[j]}`);
        j++;
      } else if (j >= modifiedLines.length) {
        // All remaining lines in original are deletions
        diff.push(`- ${originalLines[i]}`);
        i++;
      } else if (originalLines[i] === modifiedLines[j]) {
        // Lines are the same
        diff.push(`  ${originalLines[i]}`);
        i++;
        j++;
      } else {
        // Lines differ
        // Simple approach: treat as a deletion and addition
        // A more sophisticated diff would detect changes within lines
        diff.push(`- ${originalLines[i]}`);
        diff.push(`+ ${modifiedLines[j]}`);
        i++;
        j++;
      }
    }
    
    return diff.join('\n');
  }

  /**
   * Apply a patch to a file
   */
  async applyPatch(filePath: string, patch: string): Promise<FileOperationResult> {
    // In a real implementation, this would parse and apply a unified diff
    // For simplicity, we'll just write the patched content directly
    
    return this.writeFile(filePath, patch);
  }
}

/**
 * Initialize the file operations system
 */
export async function initFileOperations(config: any): Promise<FileOperationsManager> {
  logger.info('Initializing file operations system');
  
  try {
    const fileOps = new FileOperationsManager(config);
    await fileOps.initialize();
    
    logger.info('File operations system initialized successfully');
    
    return fileOps;
  } catch (error) {
    logger.error('Failed to initialize file operations system', error);
    
    // Create a basic file operations manager even if initialization failed
    return new FileOperationsManager(config);
  }
}

export default FileOperationsManager; 