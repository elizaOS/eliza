/**
 * Terminal Formatting Utilities
 * 
 * Provides functions for formatting and displaying text in the terminal.
 */

import chalk from 'chalk';

/**
 * Clear the terminal screen
 */
export function clearScreen(): void {
  // Clear screen and move cursor to top-left
  process.stdout.write('\x1b[2J\x1b[0f');
}

/**
 * Get the terminal size (rows and columns)
 */
export function getTerminalSize(): { rows: number; columns: number } {
  // Default to a reasonable size if we can't determine the actual size
  const defaultSize = { rows: 24, columns: 80 };
  
  try {
    if (process.stdout.isTTY) {
      return {
        rows: process.stdout.rows || defaultSize.rows,
        columns: process.stdout.columns || defaultSize.columns
      };
    }
  } catch (error) {
    // Ignore errors
  }
  
  return defaultSize;
}

/**
 * Options for formatting output
 */
export interface FormatOptions {
  /**
   * Terminal width in columns
   */
  width?: number;
  
  /**
   * Whether to use colors
   */
  colors?: boolean;
  
  /**
   * Whether to highlight code
   */
  codeHighlighting?: boolean;
}

/**
 * Format output for display in the terminal
 */
export function formatOutput(text: string, options: FormatOptions = {}): string {
  const { width = getTerminalSize().columns, colors = true, codeHighlighting = true } = options;
  
  if (!text) {
    return '';
  }
  
  // Process markdown-like formatting if colors are enabled
  if (colors) {
    // Format code blocks with syntax highlighting
    text = formatCodeBlocks(text, codeHighlighting);
    
    // Format inline code
    text = text.replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code));
    
    // Format bold text
    text = text.replace(/\*\*([^*]+)\*\*/g, (_, bold) => chalk.bold(bold));
    
    // Format italic text
    text = text.replace(/\*([^*]+)\*/g, (_, italic) => chalk.italic(italic));
    
    // Format lists
    text = text.replace(/^(\s*)-\s+(.+)$/gm, (_, indent, item) => 
      `${indent}${chalk.dim('•')} ${item}`
    );
    
    // Format headers
    text = text.replace(/^(#+)\s+(.+)$/gm, (_, hashes, header) => {
      if (hashes.length === 1) {
        return chalk.bold.underline.blue(header);
      } else if (hashes.length === 2) {
        return chalk.bold.blue(header);
      } else {
        return chalk.bold(header);
      }
    });
  }
  
  // Word wrap if width is specified
  if (width) {
    text = wordWrap(text, width);
  }
  
  return text;
}

/**
 * Format code blocks with syntax highlighting
 */
function formatCodeBlocks(text: string, enableHighlighting: boolean): string {
  const codeBlockRegex = /```(\w+)?\n([\s\S]+?)```/g;
  
  return text.replace(codeBlockRegex, (match, language, code) => {
    // Add syntax highlighting if enabled
    const highlightedCode = enableHighlighting && language
      ? highlightSyntax(code, language)
      : code;
    
    // Format the code block with a border
    const lines = highlightedCode.split('\n');
    const border = chalk.dim('┃');
    
    const formattedLines = lines.map(line => `${border} ${line}`);
    const top = chalk.dim('┏' + '━'.repeat(Math.max(...lines.map(l => l.length)) + 2) + '┓');
    const bottom = chalk.dim('┗' + '━'.repeat(Math.max(...lines.map(l => l.length)) + 2) + '┛');
    
    // Add language indicator if present
    const header = language 
      ? `${border} ${chalk.bold.blue(language)}\n`
      : '';
    
    return `${top}\n${header}${formattedLines.join('\n')}\n${bottom}`;
  });
}

/**
 * Simple syntax highlighting for code
 */
function highlightSyntax(code: string, language: string): string {
  // Basic syntax highlighting - in a real app, use a proper library
  // This is just a simple example with a few patterns
  
  // Common programming keywords
  const keywords = [
    'function', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'return',
    'import', 'export', 'class', 'interface', 'extends', 'implements',
    'public', 'private', 'protected', 'static', 'async', 'await'
  ];
  
  // Split by tokens that we want to preserve
  const tokens = code.split(/(\s+|[{}[\]();,.<>?:!+\-*/%&|^~=])/);
  
  return tokens.map(token => {
    // Keywords
    if (keywords.includes(token)) {
      return chalk.blue(token);
    }
    
    // Numbers
    if (/^[0-9]+(\.[0-9]+)?$/.test(token)) {
      return chalk.yellow(token);
    }
    
    // Strings
    if (/^["'].*["']$/.test(token)) {
      return chalk.green(token);
    }
    
    // Comments
    if (token.startsWith('//') || token.startsWith('/*') || token.startsWith('*')) {
      return chalk.gray(token);
    }
    
    return token;
  }).join('');
}

/**
 * Word wrap text to the specified width
 */
export function wordWrap(text: string, width: number): string {
  const lines = text.split('\n');
  
  return lines.map(line => {
    // If the line is a code block or already shorter than the width, leave it as is
    if (line.trim().startsWith('┃') || line.length <= width) {
      return line;
    }
    
    // Word wrap the line
    const words = line.split(' ');
    const wrappedLines: string[] = [];
    let currentLine = '';
    
    for (const word of words) {
      // If adding this word would exceed the width
      if (currentLine.length + word.length + 1 > width) {
        // Add the current line to wrapped lines if it's not empty
        if (currentLine) {
          wrappedLines.push(currentLine);
          currentLine = word;
        } else {
          // If the current line is empty, it means the word itself is longer than the width
          wrappedLines.push(word);
        }
      } else {
        // Add the word to the current line
        currentLine = currentLine ? `${currentLine} ${word}` : word;
      }
    }
    
    // Add the last line if it's not empty
    if (currentLine) {
      wrappedLines.push(currentLine);
    }
    
    return wrappedLines.join('\n');
  }).join('\n');
} 