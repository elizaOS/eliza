/**
 * File Operations
 * 
 * Functions for interacting with the file system in a safe and consistent way.
 * Includes utilities for reading, writing, searching, and analyzing files.
 */

import fs from 'fs/promises';
import { Stats } from 'fs';
import path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { constants } from 'fs';
import { createUserError } from '../errors/formatter.js';
import { ErrorCategory } from '../errors/types.js';
import { logger } from '../utils/logger.js';
import { isValidPath, isValidFilePath, isValidDirectoryPath } from '../utils/validation.js';

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch (error) {
    return false;
  }
}

/**
 * Check if a directory exists
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
}

/**
 * Create a directory if it doesn't exist
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    if (!await directoryExists(dirPath)) {
      await fs.mkdir(dirPath, { recursive: true });
      logger.debug(`Created directory: ${dirPath}`);
    }
  } catch (error) {
    logger.error(`Failed to create directory: ${dirPath}`, error);
    throw createUserError(`Failed to create directory: ${dirPath}`, {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM,
      resolution: 'Check file permissions and try again.'
    });
  }
}

/**
 * Read a file as text
 */
export async function readTextFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
  if (!isValidFilePath(filePath)) {
    throw createUserError(`Invalid file path: ${filePath}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide a valid file path.'
    });
  }

  try {
    if (!await fileExists(filePath)) {
      throw createUserError(`File not found: ${filePath}`, {
        category: ErrorCategory.FILE_NOT_FOUND,
        resolution: 'Check the file path and try again.'
      });
    }

    return await fs.readFile(filePath, { encoding });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createUserError(`File not found: ${filePath}`, {
        cause: error,
        category: ErrorCategory.FILE_NOT_FOUND,
        resolution: 'Check the file path and try again.'
      });
    }

    throw createUserError(`Failed to read file: ${filePath}`, {
      cause: error,
      category: ErrorCategory.FILE_READ,
      resolution: 'Check file permissions and try again.'
    });
  }
}

/**
 * Read specific lines from a file
 */
export async function readFileLines(
  filePath: string,
  start: number,
  end: number,
  encoding: BufferEncoding = 'utf-8'
): Promise<string[]> {
  try {
    const content = await readTextFile(filePath, encoding);
    const lines = content.split('\n');
    
    // Convert from 1-indexed to 0-indexed
    const startIndex = Math.max(0, start - 1);
    const endIndex = Math.min(lines.length, end);
    
    return lines.slice(startIndex, endIndex);
  } catch (error) {
    throw createUserError(`Failed to read lines ${start}-${end} from file: ${filePath}`, {
      cause: error,
      category: ErrorCategory.FILE_READ,
      resolution: 'Check the file path and line range, then try again.'
    });
  }
}

/**
 * Write text to a file
 */
export async function writeTextFile(
  filePath: string,
  content: string,
  options: { encoding?: BufferEncoding; createDir?: boolean; overwrite?: boolean } = {}
): Promise<void> {
  const { encoding = 'utf-8', createDir = true, overwrite = true } = options;
  
  if (!isValidFilePath(filePath)) {
    throw createUserError(`Invalid file path: ${filePath}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide a valid file path.'
    });
  }
  
  try {
    // Ensure directory exists if createDir is true
    if (createDir) {
      const dirPath = path.dirname(filePath);
      await ensureDirectory(dirPath);
    }
    
    // Check if file exists and overwrite is false
    const exists = await fileExists(filePath);
    if (exists && !overwrite) {
      throw createUserError(`File already exists: ${filePath}`, {
        category: ErrorCategory.FILE_SYSTEM,
        resolution: 'Use overwrite option to replace existing file.'
      });
    }
    
    // Write the file
    await fs.writeFile(filePath, content, { encoding });
    logger.debug(`Wrote ${content.length} bytes to: ${filePath}`);
  } catch (error) {
    if ((error as any).category) {
      throw error; // Re-throw user errors
    }
    
    throw createUserError(`Failed to write file: ${filePath}`, {
      cause: error,
      category: ErrorCategory.FILE_WRITE,
      resolution: 'Check file permissions and try again.'
    });
  }
}

/**
 * Append text to a file
 */
export async function appendTextFile(
  filePath: string,
  content: string,
  options: { encoding?: BufferEncoding; createDir?: boolean } = {}
): Promise<void> {
  const { encoding = 'utf-8', createDir = true } = options;
  
  if (!isValidFilePath(filePath)) {
    throw createUserError(`Invalid file path: ${filePath}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide a valid file path.'
    });
  }
  
  try {
    // Ensure directory exists if createDir is true
    if (createDir) {
      const dirPath = path.dirname(filePath);
      await ensureDirectory(dirPath);
    }
    
    // Append to the file
    await fs.appendFile(filePath, content, { encoding });
    logger.debug(`Appended ${content.length} bytes to: ${filePath}`);
  } catch (error) {
    throw createUserError(`Failed to append to file: ${filePath}`, {
      cause: error,
      category: ErrorCategory.FILE_WRITE,
      resolution: 'Check file permissions and try again.'
    });
  }
}

/**
 * Delete a file
 */
export async function deleteFile(filePath: string): Promise<void> {
  if (!isValidFilePath(filePath)) {
    throw createUserError(`Invalid file path: ${filePath}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide a valid file path.'
    });
  }
  
  try {
    const exists = await fileExists(filePath);
    if (!exists) {
      logger.debug(`File does not exist, nothing to delete: ${filePath}`);
      return;
    }
    
    await fs.unlink(filePath);
    logger.debug(`Deleted file: ${filePath}`);
  } catch (error) {
    throw createUserError(`Failed to delete file: ${filePath}`, {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM,
      resolution: 'Check file permissions and try again.'
    });
  }
}

/**
 * Rename a file or directory
 */
export async function rename(oldPath: string, newPath: string): Promise<void> {
  if (!isValidPath(oldPath) || !isValidPath(newPath)) {
    throw createUserError(`Invalid path: ${!isValidPath(oldPath) ? oldPath : newPath}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide valid file paths.'
    });
  }
  
  try {
    const exists = await fileExists(oldPath) || await directoryExists(oldPath);
    if (!exists) {
      throw createUserError(`Path not found: ${oldPath}`, {
        category: ErrorCategory.FILE_NOT_FOUND,
        resolution: 'Check the source path and try again.'
      });
    }
    
    await fs.rename(oldPath, newPath);
    logger.debug(`Renamed: ${oldPath} -> ${newPath}`);
  } catch (error) {
    if ((error as any).category) {
      throw error; // Re-throw user errors
    }
    
    throw createUserError(`Failed to rename: ${oldPath} -> ${newPath}`, {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM,
      resolution: 'Check file permissions and ensure destination path is valid.'
    });
  }
}

/**
 * Copy a file
 */
export async function copyFile(
  sourcePath: string,
  destPath: string,
  options: { overwrite?: boolean; createDir?: boolean } = {}
): Promise<void> {
  const { overwrite = false, createDir = true } = options;
  
  if (!isValidFilePath(sourcePath) || !isValidFilePath(destPath)) {
    throw createUserError(`Invalid file path: ${!isValidFilePath(sourcePath) ? sourcePath : destPath}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide valid file paths.'
    });
  }
  
  try {
    // Check if source exists
    if (!await fileExists(sourcePath)) {
      throw createUserError(`Source file not found: ${sourcePath}`, {
        category: ErrorCategory.FILE_NOT_FOUND,
        resolution: 'Check the source path and try again.'
      });
    }
    
    // Ensure directory exists if createDir is true
    if (createDir) {
      const dirPath = path.dirname(destPath);
      await ensureDirectory(dirPath);
    }
    
    // Set copy flags
    const flags = overwrite ? 0 : constants.COPYFILE_EXCL;
    
    await fs.copyFile(sourcePath, destPath, flags);
    logger.debug(`Copied file: ${sourcePath} -> ${destPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && !overwrite) {
      throw createUserError(`Destination file already exists: ${destPath}`, {
        cause: error,
        category: ErrorCategory.FILE_SYSTEM,
        resolution: 'Use overwrite option to replace existing file.'
      });
    }
    
    if ((error as any).category) {
      throw error; // Re-throw user errors
    }
    
    throw createUserError(`Failed to copy file: ${sourcePath} -> ${destPath}`, {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM,
      resolution: 'Check file permissions and paths, then try again.'
    });
  }
}

/**
 * List files and directories in a directory
 */
export async function listDirectory(dirPath: string): Promise<string[]> {
  if (!isValidDirectoryPath(dirPath)) {
    throw createUserError(`Invalid directory path: ${dirPath}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide a valid directory path.'
    });
  }
  
  try {
    if (!await directoryExists(dirPath)) {
      throw createUserError(`Directory not found: ${dirPath}`, {
        category: ErrorCategory.FILE_NOT_FOUND,
        resolution: 'Check the directory path and try again.'
      });
    }
    
    return await fs.readdir(dirPath);
  } catch (error) {
    if ((error as any).category) {
      throw error; // Re-throw user errors
    }
    
    throw createUserError(`Failed to list directory: ${dirPath}`, {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM,
      resolution: 'Check directory permissions and try again.'
    });
  }
}

/**
 * Get file or directory information
 */
export async function getFileInfo(filePath: string): Promise<Stats> {
  if (!isValidPath(filePath)) {
    throw createUserError(`Invalid path: ${filePath}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide a valid file or directory path.'
    });
  }
  
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createUserError(`Path not found: ${filePath}`, {
        cause: error,
        category: ErrorCategory.FILE_NOT_FOUND,
        resolution: 'Check the path and try again.'
      });
    }
    
    throw createUserError(`Failed to get file info: ${filePath}`, {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM,
      resolution: 'Check permissions and try again.'
    });
  }
}

/**
 * Find files matching a pattern
 */
export async function findFiles(
  directory: string,
  options: { pattern?: RegExp; recursive?: boolean; includeDirectories?: boolean } = {}
): Promise<string[]> {
  const { pattern, recursive = true, includeDirectories = false } = options;
  
  if (!isValidDirectoryPath(directory)) {
    throw createUserError(`Invalid directory path: ${directory}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide a valid directory path.'
    });
  }
  
  try {
    if (!await directoryExists(directory)) {
      throw createUserError(`Directory not found: ${directory}`, {
        category: ErrorCategory.FILE_NOT_FOUND,
        resolution: 'Check the directory path and try again.'
      });
    }
    
    const results: string[] = [];
    
    // Helper function to traverse the directory
    async function traverseDirectory(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          if (includeDirectories && (!pattern || pattern.test(entry.name))) {
            results.push(fullPath);
          }
          
          if (recursive) {
            await traverseDirectory(fullPath);
          }
        } else if (entry.isFile()) {
          if (!pattern || pattern.test(entry.name)) {
            results.push(fullPath);
          }
        }
      }
    }
    
    await traverseDirectory(directory);
    return results;
  } catch (error) {
    if ((error as any).category) {
      throw error; // Re-throw user errors
    }
    
    throw createUserError(`Failed to find files in directory: ${directory}`, {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM,
      resolution: 'Check directory permissions and try again.'
    });
  }
}

/**
 * Stream a file to another location
 */
export async function streamFile(
  sourcePath: string,
  destPath: string,
  options: { overwrite?: boolean; createDir?: boolean } = {}
): Promise<void> {
  const { overwrite = false, createDir = true } = options;
  
  if (!isValidFilePath(sourcePath) || !isValidFilePath(destPath)) {
    throw createUserError(`Invalid file path: ${!isValidFilePath(sourcePath) ? sourcePath : destPath}`, {
      category: ErrorCategory.VALIDATION,
      resolution: 'Provide valid file paths.'
    });
  }
  
  try {
    // Check if source exists
    if (!await fileExists(sourcePath)) {
      throw createUserError(`Source file not found: ${sourcePath}`, {
        category: ErrorCategory.FILE_NOT_FOUND,
        resolution: 'Check the source path and try again.'
      });
    }
    
    // Check if destination exists and overwrite is false
    if (!overwrite && await fileExists(destPath)) {
      throw createUserError(`Destination file already exists: ${destPath}`, {
        category: ErrorCategory.FILE_SYSTEM,
        resolution: 'Use overwrite option to replace existing file.'
      });
    }
    
    // Ensure directory exists if createDir is true
    if (createDir) {
      const dirPath = path.dirname(destPath);
      await ensureDirectory(dirPath);
    }
    
    const source = createReadStream(sourcePath);
    const destination = createWriteStream(destPath);
    
    await pipeline(source, destination);
    logger.debug(`Streamed file: ${sourcePath} -> ${destPath}`);
  } catch (error) {
    if ((error as any).category) {
      throw error; // Re-throw user errors
    }
    
    throw createUserError(`Failed to stream file: ${sourcePath} -> ${destPath}`, {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM,
      resolution: 'Check file permissions and paths, then try again.'
    });
  }
}

/**
 * Create a temporary file
 */
export async function createTempFile(
  options: { prefix?: string; suffix?: string; content?: string } = {}
): Promise<string> {
  const { prefix = 'tmp-', suffix = '', content = '' } = options;
  
  try {
    // Create a temporary filename
    const tempDir = await fs.mkdtemp(path.join(path.resolve(process.env.TEMP || process.env.TMP || '/tmp'), prefix));
    const tempFileName = `${prefix}${Date.now()}${suffix}`;
    const tempFilePath = path.join(tempDir, tempFileName);
    
    // Write content if provided
    if (content) {
      await fs.writeFile(tempFilePath, content);
    } else {
      await fs.writeFile(tempFilePath, '');
    }
    
    logger.debug(`Created temporary file: ${tempFilePath}`);
    return tempFilePath;
  } catch (error) {
    throw createUserError('Failed to create temporary file', {
      cause: error,
      category: ErrorCategory.FILE_SYSTEM,
      resolution: 'Check temporary directory permissions and try again.'
    });
  }
} 