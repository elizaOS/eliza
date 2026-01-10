/**
 * Formatting Utilities
 * 
 * Provides utilities for formatting text, truncating strings,
 * handling terminal output, and other formatting tasks.
 */

/**
 * Truncate a string to a maximum length
 */
export function truncate(text: string, maxLength: number, suffix: string = '...'): string {
  if (!text || text.length <= maxLength) {
    return text;
  }
  
  return text.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Format a number with commas as thousands separators
 */
export function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a date to ISO string without milliseconds
 */
export function formatDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Format a file size in bytes to a human-readable string
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Format a duration in milliseconds to a human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  
  const seconds = Math.floor(ms / 1000);
  
  if (seconds < 60) {
    return `${seconds}s`;
  }
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  if (hours < 24) {
    return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
  }
  
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  
  return `${days}d ${remainingHours}h ${remainingMinutes}m`;
}

/**
 * Indent a string with a specified number of spaces
 */
export function indent(text: string, spaces: number = 2): string {
  const indentation = ' '.repeat(spaces);
  return text.split('\n').map(line => indentation + line).join('\n');
}

/**
 * Strip ANSI escape codes from a string
 */
export function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Wrap text to a specified width
 */
export function wrapText(text: string, width: number = 80): string {
  const lines = text.split('\n');
  return lines.map(line => {
    if (line.length <= width) {
      return line;
    }
    
    const wrappedLines = [];
    let currentLine = '';
    
    const words = line.split(' ');
    for (const word of words) {
      if ((currentLine + word).length <= width) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) {
          wrappedLines.push(currentLine);
        }
        
        currentLine = word.length > width ? word.substring(0, width) : word;
        
        if (word.length > width) {
          let remaining = word.substring(width);
          while (remaining.length > 0) {
            wrappedLines.push(remaining.substring(0, width));
            remaining = remaining.substring(width);
          }
        }
      }
    }
    
    if (currentLine) {
      wrappedLines.push(currentLine);
    }
    
    return wrappedLines.join('\n');
  }).join('\n');
}

/**
 * Pad a string to a fixed width
 */
export function padString(text: string, width: number, padChar: string = ' ', padRight: boolean = true): string {
  if (text.length >= width) {
    return text;
  }
  
  const padding = padChar.repeat(width - text.length);
  return padRight ? text + padding : padding + text;
}

/**
 * Center a string within a fixed width
 */
export function centerString(text: string, width: number, padChar: string = ' '): string {
  if (text.length >= width) {
    return text;
  }
  
  const leftPadding = Math.floor((width - text.length) / 2);
  const rightPadding = width - text.length - leftPadding;
  
  return padChar.repeat(leftPadding) + text + padChar.repeat(rightPadding);
}

/**
 * Create a simple text table
 */
export function createTextTable(rows: string[][], headers?: string[]): string {
  if (rows.length === 0) {
    return '';
  }
  
  // Add headers as first row if provided
  const allRows = headers ? [headers, ...rows] : rows;
  
  // Calculate column widths
  const columnWidths: number[] = [];
  
  for (const row of allRows) {
    for (let i = 0; i < row.length; i++) {
      const cellWidth = String(row[i]).length;
      
      if (!columnWidths[i] || cellWidth > columnWidths[i]) {
        columnWidths[i] = cellWidth;
      }
    }
  }
  
  // Format rows
  const formattedRows = allRows.map(row => {
    return row.map((cell, i) => padString(String(cell), columnWidths[i])).join(' | ');
  });
  
  // Add separator after headers if provided
  if (headers) {
    const separator = columnWidths.map(width => '-'.repeat(width)).join('-+-');
    formattedRows.splice(1, 0, separator);
  }
  
  return formattedRows.join('\n');
}

/**
 * Format a key-value object as a string
 */
export function formatKeyValue(obj: Record<string, any>, options: { 
  indent?: number; 
  keyValueSeparator?: string;
  includeEmpty?: boolean;
} = {}): string {
  const { 
    indent = 0, 
    keyValueSeparator = ': ',
    includeEmpty = false
  } = options;
  
  const indentation = ' '.repeat(indent);
  const lines: string[] = [];
  
  for (const [key, value] of Object.entries(obj)) {
    if (!includeEmpty && (value === undefined || value === null || value === '')) {
      continue;
    }
    
    const valueStr = typeof value === 'object' && value !== null
      ? JSON.stringify(value)
      : String(value);
    
    lines.push(`${indentation}${key}${keyValueSeparator}${valueStr}`);
  }
  
  return lines.join('\n');
}

/**
 * Convert camelCase to Title Case
 */
export function camelToTitleCase(text: string): string {
  if (!text) return text;
  
  // Insert a space before all uppercase letters
  const spaceSeparated = text.replace(/([A-Z])/g, ' $1');
  
  // Capitalize the first letter
  return spaceSeparated.charAt(0).toUpperCase() + spaceSeparated.slice(1);
}

/**
 * Format error details
 */
export function formatErrorDetails(error: Error): string {
  let details = `Error: ${error.message}`;
  
  if (error.stack) {
    details += `\nStack: ${error.stack.split('\n').slice(1).join('\n')}`;
  }
  
  // Add any additional properties that might be present
  for (const key of Object.keys(error)) {
    if (!['name', 'message', 'stack'].includes(key)) {
      const value = (error as any)[key];
      if (value !== undefined && value !== null) {
        details += `\n${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`;
      }
    }
  }
  
  return details;
}

export default {
  truncate,
  formatNumber,
  formatDate,
  formatFileSize,
  formatDuration,
  indent,
  stripAnsi,
  wrapText,
  padString,
  centerString,
  createTextTable,
  formatKeyValue,
  camelToTitleCase,
  formatErrorDetails
}; 