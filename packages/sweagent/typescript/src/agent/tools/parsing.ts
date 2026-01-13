/**
 * Parsing functions for agent actions
 * Converted from sweagent/tools/parsing.py
 */

import { FormatError } from '../../exceptions';
import { ModelOutput, Command } from '../types';

/**
 * Abstract base class for parse functions
 */
export abstract class AbstractParseFunction {
  abstract type: string;
  formatErrorTemplate?: string;

  abstract call(modelResponse: ModelOutput | string, _commands?: Command[], strict?: boolean): [string, string];

  parse(modelResponse: ModelOutput | string, commands?: Command[], strict: boolean = true): [string, string] {
    return this.call(modelResponse, commands, strict);
  }
}

/**
 * Thought-Action parser for parsing both thought and action
 */
export class ThoughtActionParser extends AbstractParseFunction {
  type = 'thought_action' as const;

  call(modelResponse: ModelOutput | string, _commands?: Command[], strict: boolean = false): [string, string] {
    const message =
      typeof modelResponse === 'string' ? modelResponse : modelResponse.message || modelResponse.content || '';

    // First try to parse code blocks (most common format)
    const codeBlockMatch = message.match(/```(?:bash|sh)?\n(.*?)```/s);
    if (codeBlockMatch) {
      // Everything before the code block is the thought
      const codeBlockIndex = message.indexOf(codeBlockMatch[0]);
      const thought = message.substring(0, codeBlockIndex);
      const action = codeBlockMatch[1];
      return [thought, action];
    }

    // Parse thought and action from response with emoji markers
    const thoughtMatch = message.match(/💭\s*THOUGHT[:\s]*([^\n]*(?:\n(?!🎬|ACTION)[^\n]*)*)/i);
    const actionMatch = message.match(/🎬\s*ACTION[:\s]*(.*?)(?=\n💭|\n🎬|$)/is);

    const thought = thoughtMatch ? thoughtMatch[1].trim() : '';
    const action = actionMatch ? actionMatch[1].trim() : '';

    if (!thought && !action) {
      // Try alternative format
      const lines = message.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.toLowerCase().includes('thought:')) {
          const thoughtStart = line.indexOf(':') + 1;
          const thoughtLines = [line.substring(thoughtStart).trim()];
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].toLowerCase().includes('action:')) {
              break;
            }
            thoughtLines.push(lines[j]);
          }
          return [thoughtLines.join('\n').trim(), ''];
        }
        if (line.toLowerCase().includes('action:')) {
          const actionStart = line.indexOf(':') + 1;
          const actionLines = [line.substring(actionStart).trim()];
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].toLowerCase().includes('thought:')) {
              break;
            }
            actionLines.push(lines[j]);
          }
          return [thought || '', actionLines.join('\n').trim()];
        }
      }
    }

    if (strict && !action) {
      throw new FormatError('Could not parse action from model response');
    }

    return [thought, action];
  }
}

/**
 * Action-only parser (no thought parsing)
 */
export class ActionOnlyParser extends AbstractParseFunction {
  type = 'action_only' as const;

  call(modelResponse: ModelOutput | string, _commands?: Command[], strict: boolean = false): [string, string] {
    const message =
      typeof modelResponse === 'string' ? modelResponse : modelResponse.message || modelResponse.content || '';

    // For action-only, the entire message is the action
    const action = message.trim();

    if (strict && !action) {
      throw new FormatError('Could not parse action from model response');
    }

    // Validate against allowed commands if in strict mode
    if (strict && _commands && _commands.length > 0) {
      // Check if the action starts with any valid command
      const actionParts = action.split(/\s+/);
      const commandName = actionParts[0];
      const validCommand = _commands.find((cmd) => cmd.name === commandName);
      if (!validCommand) {
        throw new FormatError(`Invalid command: ${commandName}`);
      }
    }

    return ['', action];
  }
}

/**
 * XML-based thought-action parser
 */
export class XMLThoughtActionParser extends AbstractParseFunction {
  type = 'xml_thought_action' as const;

  call(modelResponse: ModelOutput | string, _commands?: Command[], strict: boolean = false): [string, string] {
    const message =
      typeof modelResponse === 'string' ? modelResponse : modelResponse.message || modelResponse.content || '';

    // Parse XML-style tags - support both <action> and <command>
    const thoughtMatch = message.match(/<thought>(.*?)<\/thought>/is);
    const actionMatch = message.match(/<action>(.*?)<\/action>/is);
    const commandMatch = message.match(/<command>(.*?)<\/command>/is);

    const thought = thoughtMatch ? thoughtMatch[1].trim() : '';
    const action = actionMatch ? actionMatch[1].trim() : commandMatch ? commandMatch[1].trim() : '';

    // If there's a command tag, everything before it is the thought
    if (commandMatch && !thought) {
      const commandIndex = message.indexOf(commandMatch[0]);
      const thoughtText = message.substring(0, commandIndex).trim();
      return [thoughtText, commandMatch[1].trim()];
    }

    if (strict && !action) {
      throw new FormatError('Could not parse action from model response');
    }

    return [thought, action];
  }
}

/**
 * Edit format parser for special edit commands
 */
export class EditFormatParser extends ThoughtActionParser {
  // Uses same type as parent 'thought_action'

  call(modelResponse: ModelOutput | string, _commands?: Command[], strict: boolean = false): [string, string] {
    const [thought, action] = super.call(modelResponse, _commands, strict);

    // Check for edit command format
    if (action.includes('str_replace_editor') || action.includes('str_replace_based_edit_tool')) {
      // Parse the edit format
      const editMatch = action.match(/<<<(.*?)>>>/s);
      if (editMatch) {
        return [thought, editMatch[1].trim()];
      }
    }

    return [thought, action];
  }
}

/**
 * Function calling parser for OpenAI-style function calls
 */
export class FunctionCallingParser extends AbstractParseFunction {
  type = 'function_calling' as const;

  formatErrorMessage(error: { errorCode?: string; message?: string }): string {
    if (error.errorCode === 'missing') {
      return 'The model did not use any tool calls';
    }
    return error.message || 'Unknown error';
  }

  call(modelResponse: ModelOutput | string, _commands?: Command[], strict: boolean = false): [string, string] {
    // Handle function calling format - support both toolCalls and tool_calls
    const toolCalls =
      typeof modelResponse !== 'string' ? modelResponse.toolCalls || (modelResponse as any).tool_calls : null;

    if (toolCalls && toolCalls.length > 0) {
      if (toolCalls.length > 1 && strict) {
        throw new FormatError('Multiple tool calls not supported');
      }

      const toolCall = toolCalls[0];
      const functionName = toolCall.function.name;
      const args = toolCall.function.arguments;

      // Validate against allowed commands
      if (_commands && _commands.length > 0 && strict) {
        const validCommand = _commands.find((cmd) => cmd.name === functionName);
        if (!validCommand) {
          throw new FormatError(`Invalid command: ${functionName}`);
        }
      }

      // Convert to command format
      let action = functionName;
      if (args) {
        try {
          const argsObj = typeof args === 'string' ? JSON.parse(args) : args;
          if (argsObj && typeof argsObj === 'object' && Object.keys(argsObj).length > 0) {
            if (argsObj.command) {
              action = String(argsObj.command);
            } else {
              // Don't append empty object
              const values = Object.values(argsObj).filter((v) => v !== undefined && v !== null && v !== '');
              if (values.length > 0) {
                action = `${functionName} ${values.map((v) => String(v)).join(' ')}`;
              }
            }
          }
        } catch (e) {
          if (strict) {
            throw new FormatError('Invalid JSON in function arguments');
          }
        }
      }

      const thought = typeof modelResponse !== 'string' ? modelResponse.message || '' : '';
      return [thought, action];
    }

    if (strict) {
      throw new FormatError('No tool calls found in model response');
    }

    // Fallback to regular parsing
    const message = typeof modelResponse === 'string' ? modelResponse : modelResponse.message || '';
    return ['', message];
  }
}

/**
 * Single bash code block parser
 */
export class SingleBashCodeBlockParser extends AbstractParseFunction {
  type = 'single_bash_code_block' as const;

  call(modelResponse: ModelOutput | string, _commands?: Command[], strict: boolean = false): [string, string] {
    const message =
      typeof modelResponse === 'string' ? modelResponse : modelResponse.message || modelResponse.content || '';

    // Look for bash code block
    const codeBlockMatch = message.match(/```(?:bash|sh)?\n(.*?)```/s);

    if (codeBlockMatch) {
      return ['', codeBlockMatch[1].trim()];
    }

    if (strict) {
      throw new FormatError('Could not find bash code block in model response');
    }

    // Return the whole message as action if no code block found
    return ['', message.trim()];
  }
}

/**
 * Multiple bash code blocks parser
 */
export class MultipleBashCodeBlocksParser extends AbstractParseFunction {
  type = 'multiple_bash_code_blocks' as const;

  call(modelResponse: ModelOutput | string, _commands?: Command[], strict: boolean = false): [string, string] {
    const message =
      typeof modelResponse === 'string' ? modelResponse : modelResponse.message || modelResponse.content || '';

    // Find all bash code blocks
    const codeBlocks: string[] = [];
    const regex = /```(?:bash|sh)?\n(.*?)```/gs;
    let match;

    while ((match = regex.exec(message)) !== null) {
      codeBlocks.push(match[1].trim());
    }

    if (codeBlocks.length > 0) {
      // Join multiple blocks with newlines
      return ['', codeBlocks.join('\n\n')];
    }

    if (strict) {
      throw new FormatError('Could not find bash code blocks in model response');
    }

    return ['', message.trim()];
  }
}

/**
 * Identity parser - returns input as both thought and action
 */
export class Identity extends AbstractParseFunction {
  type = 'identity' as const;

  call(modelResponse: ModelOutput | string, _commands?: Command[], _strict: boolean = false): [string, string] {
    const message =
      typeof modelResponse === 'string' ? modelResponse : modelResponse.message || modelResponse.content || '';

    // Try to extract code block if present
    const codeBlockMatch = message.match(/```(?:bash|sh)?\n(.*?)```/s);
    if (codeBlockMatch) {
      const action = codeBlockMatch[1].trim();
      return [message, action];
    }

    return [message, message];
  }
}

/**
 * Last line parser - uses only the last line as action
 */
export class LastLineParser extends AbstractParseFunction {
  type = 'last_line' as const;

  call(modelResponse: ModelOutput | string, _commands?: Command[], strict: boolean = false): [string, string] {
    const message =
      typeof modelResponse === 'string' ? modelResponse : modelResponse.message || modelResponse.content || '';

    const lines = message.trim().split('\n');
    const lastLine = lines[lines.length - 1].trim();

    if (strict && !lastLine) {
      throw new FormatError('Could not parse action from model response');
    }

    // Everything except last line is thought
    const thought = lines.slice(0, -1).join('\n').trim();

    return [thought, lastLine];
  }
}

/**
 * Factory function to get parser by name
 */
export function getParser(parserName: string): AbstractParseFunction {
  switch (parserName) {
    case 'identity':
      return new Identity();
    case 'thought_action':
      return new ThoughtActionParser();
    case 'action_only':
      return new ActionOnlyParser();
    case 'xml_thought_action':
      return new XMLThoughtActionParser();
    case 'edit_format':
      return new EditFormatParser();
    case 'function_calling':
      return new FunctionCallingParser();
    case 'single_bash_code_block':
      return new SingleBashCodeBlockParser();
    case 'multiple_bash_code_blocks':
      return new MultipleBashCodeBlocksParser();
    case 'last_line':
      return new LastLineParser();
    case 'identity':
      return new IdentityParser();
    default:
      throw new Error(`Unknown parser: ${parserName}`);
  }
}

/**
 * Main parse function used by tools
 */
export function parseAction(
  modelResponse: ModelOutput | string,
  parseFunction: string | AbstractParseFunction = 'thought_action',
  commands?: Command[],
  strict: boolean = false,
): [string, string] {
  let parser: AbstractParseFunction;

  if (typeof parseFunction === 'string') {
    parser = getParser(parseFunction);
  } else {
    parser = parseFunction;
  }

  return parser.call(modelResponse, commands, strict);
}

// Export types
export type ParseFunction = AbstractParseFunction;

// Identity parser for testing
export class IdentityParser extends AbstractParseFunction {
  type = 'identity' as const;

  call(modelResponse: ModelOutput | string, _commands?: Command[], _strict?: boolean): [string, string] {
    const content = typeof modelResponse === 'object' ? modelResponse.message || '' : modelResponse;
    // For identity parser, just return the content directly as the action
    return ['', content.trim()];
  }
}

// Additional exports for compatibility
export class JsonParser extends AbstractParseFunction {
  type = 'json' as const;

  call(modelResponse: ModelOutput | string, _commands?: Command[], strict?: boolean): [string, string] {
    const message =
      typeof modelResponse === 'string' ? modelResponse : modelResponse.message || modelResponse.content || '';

    try {
      const parsed = JSON.parse(message);

      if (!parsed.thought || !parsed.command) {
        if (strict) {
          throw new FormatError('JSON must contain both "thought" and "command" keys');
        }
        return ['', message];
      }

      const thought = parsed.thought;
      let action = '';

      if (typeof parsed.command === 'string') {
        action = parsed.command;
      } else if (parsed.command.name) {
        action = parsed.command.name;
        if (parsed.command.arguments) {
          if (typeof parsed.command.arguments === 'string') {
            action += ' ' + parsed.command.arguments;
          } else if (parsed.command.arguments.path) {
            action += ' ' + parsed.command.arguments.path;
          }
        }
      }

      return [thought, action];
    } catch (e) {
      if (strict) {
        throw new FormatError('Invalid JSON format');
      }
      return ['', message];
    }
  }
}

/**
 * Create a parser instance based on the specified type
 * @param type - The parser type to create
 * @returns An instance of the appropriate parser
 */
export function createParser(type: string): AbstractParseFunction {
  return getParser(type);
}
