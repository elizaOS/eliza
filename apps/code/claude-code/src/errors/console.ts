/**
 * Console Error Handling
 * 
 * Utilities for handling console errors and setting up error handling for console output.
 */

import { ErrorManager, ErrorCategory, ErrorLevel } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Set up console error handling
 */
export function setupConsoleErrorHandling(errorManager: ErrorManager): void {
  // Store original console methods
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  
  // Override console.error to track and handle errors
  console.error = function(...args: any[]): void {
    // Use the original console.error for output
    originalConsoleError.apply(console, args);
    
    // Don't process logger errors to avoid infinite recursion
    if (args[0] && typeof args[0] === 'string' && (
      args[0].includes('FATAL ERROR:') ||
      args[0].includes('Uncaught Exception:') ||
      args[0].includes('Unhandled Promise Rejection:')
    )) {
      return;
    }
    
    // Extract the error from the arguments
    const error = extractErrorFromArgs(args);
    
    // Track the error
    if (error) {
      errorManager.handleError(error, {
        level: ErrorLevel.MINOR,
        category: ErrorCategory.APPLICATION,
        context: { source: 'console.error' }
      });
    }
  };
  
  // Override console.warn to track warnings
  console.warn = function(...args: any[]): void {
    // Use the original console.warn for output
    originalConsoleWarn.apply(console, args);
    
    // Extract the warning from the arguments
    const warning = extractErrorFromArgs(args);
    
    // Track the warning as an informational error
    if (warning) {
      errorManager.handleError(warning, {
        level: ErrorLevel.INFORMATIONAL,
        category: ErrorCategory.APPLICATION,
        context: { source: 'console.warn' }
      });
    }
  };
  
  logger.debug('Console error handling set up');
}

/**
 * Extract an error from console arguments
 */
function extractErrorFromArgs(args: any[]): Error | string | null {
  if (args.length === 0) {
    return null;
  }
  
  // Check for Error objects
  for (const arg of args) {
    if (arg instanceof Error) {
      return arg;
    }
  }
  
  // If no Error object found, convert to string
  try {
    const message = args.map(arg => {
      if (typeof arg === 'string') {
        return arg;
      } else if (arg === null || arg === undefined) {
        return String(arg);
      } else {
        try {
          return JSON.stringify(arg);
        } catch (error) {
          return String(arg);
        }
      }
    }).join(' ');
    
    return message || null;
  } catch (error) {
    // If all else fails, return a generic message
    return 'Console error occurred';
  }
} 