/**
 * Tool utilities
 * Converted from sweagent/tools/utils.py
 */

import { Command } from './commands';

/**
 * Guard multiline input
 */
export function guardMultilineInput(action: string, matchFct: (action: string) => RegExpMatchArray | null): string {
  const match = matchFct(action);
  if (!match) {
    return action;
  }

  // Handle multiline input by ensuring proper formatting
  const lines = action.split('\n');
  const processedLines = lines.map((line) => line.trimEnd());
  return processedLines.join('\n');
}

/**
 * Check if a value should be quoted
 */
export function shouldQuote(value: unknown, command: Command): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  // Check if value contains spaces or special characters
  if (/[\s"'`$]/.test(value)) {
    return true;
  }

  // Check command-specific quoting rules
  for (const arg of command.arguments) {
    if (arg.type === 'string' && arg.required) {
      return true;
    }
  }

  return false;
}

/**
 * Get command signature
 */
export function getSignature(cmd: Command): string {
  if (cmd.signature) {
    return cmd.signature;
  }

  let sig = cmd.name;

  for (const arg of cmd.arguments) {
    if (arg.required) {
      sig += ` <${arg.name}>`;
    } else {
      sig += ` [${arg.name}]`;
    }
  }

  if (cmd.endName) {
    sig += '\n...\n' + cmd.endName;
  }

  return sig;
}

/**
 * Generate command documentation
 */
export function generateCommandDocs(
  commands: Command[],
  subroutineTypes: string[],
  _kwargs: Record<string, any>,
): string {
  const docs: string[] = [];

  // Group commands by type
  const bashCommands: Command[] = [];
  const subroutineCommands: Command[] = [];
  const utilityCommands: Command[] = [];

  for (const cmd of commands) {
    if (cmd.name === 'bash' || cmd.name === 'shell') {
      bashCommands.push(cmd);
    } else if (subroutineTypes.includes(cmd.name)) {
      subroutineCommands.push(cmd);
    } else {
      utilityCommands.push(cmd);
    }
  }

  // Add bash commands
  if (bashCommands.length > 0) {
    docs.push('# Bash Commands');
    docs.push('Use bash commands to interact with the system.');
    for (const cmd of bashCommands) {
      docs.push(formatCommand(cmd));
    }
    docs.push('');
  }

  // Add subroutine commands
  if (subroutineCommands.length > 0) {
    docs.push('# Subroutine Commands');
    for (const cmd of subroutineCommands) {
      docs.push(formatCommand(cmd));
    }
    docs.push('');
  }

  // Add utility commands
  if (utilityCommands.length > 0) {
    docs.push('# Utility Commands');
    for (const cmd of utilityCommands) {
      docs.push(formatCommand(cmd));
    }
    docs.push('');
  }

  return docs.join('\n');
}

/**
 * Format a single command for documentation
 */
function formatCommand(cmd: Command): string {
  const lines: string[] = [];

  // Add signature
  lines.push(`## ${getSignature(cmd)}`);

  // Add docstring
  if (cmd.docstring) {
    lines.push(cmd.docstring);
  }

  // Add arguments
  if (cmd.arguments.length > 0) {
    lines.push('Arguments:');
    for (const arg of cmd.arguments) {
      const required = arg.required ? ' (required)' : ' (optional)';
      lines.push(`  - ${arg.name}: ${arg.description}${required}`);
      if (arg.enum) {
        lines.push(`    Allowed values: ${arg.enum.join(', ')}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}
