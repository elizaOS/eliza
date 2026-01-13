/**
 * Tool parsing functions
 * Converted from sweagent/tools/parsing.py
 */

import { Command } from './commands';
import { FormatError, FunctionCallingFormatError } from '../exceptions';
import { ModelResponse } from '../types';

/**
 * Abstract base class for parsing functions
 */
export abstract class AbstractParseFunction {
  errorMessage: string = '';
  type?: string;

  abstract parse(modelResponse: ModelResponse, commands: Command[], strict?: boolean): [string, string];

  get formatErrorTemplate(): string {
    return this.errorMessage;
  }
}

/**
 * Action parser - expects single command
 */
export class ActionParser extends AbstractParseFunction {
  type = 'action';
  errorMessage = `The command you provided was not recognized. Please specify one of the commands (+ any necessary arguments) from the following list in your response. Do not include any other text.

COMMANDS:
{command_docs}`;

  parse(modelResponse: ModelResponse, _commands: Command[], _strict: boolean = false): [string, string] {
    const message = modelResponse.message || '';
    const action = message.trim();

    if (!action) {
      throw new FormatError('No action found in response');
    }

    return ['', action];
  }
}

/**
 * Action-only parser
 */
export class ActionOnlyParser extends AbstractParseFunction {
  type = 'action_only';
  errorMessage = 'No message found in model response.';

  parse(modelResponse: ModelResponse, _commands: Command[], _strict: boolean = false): [string, string] {
    const message = modelResponse.message || '';
    return ['', message];
  }
}

/**
 * Thought-action parser - expects discussion followed by backtick-wrapped command
 */
export class ThoughtActionParser extends AbstractParseFunction {
  type = 'thought_action';
  errorMessage = `Your output was not formatted correctly. You must always include one discussion and one command as part of your response. Make sure you do not have multiple discussion/command tags.
Please make sure your output precisely matches the following format:
DISCUSSION
Discuss here with yourself about what your planning and what you're going to do in this step.

\`\`\`
command(s) that you're going to run
\`\`\``;

  parse(modelResponse: ModelResponse, _commands: Command[], strict: boolean = false): [string, string] {
    const message = modelResponse.message || '';

    // Find backtick blocks
    const backtickPattern = /```([\s\S]*?)```/g;
    const matches = Array.from(message.matchAll(backtickPattern));

    if (matches.length === 0) {
      if (strict) {
        throw new FormatError('No code block found in response');
      }
      return [message, ''];
    }

    if (matches.length > 1 && strict) {
      throw new FormatError('Multiple code blocks found in response');
    }

    const match = matches[0] as RegExpMatchArray;
    const codeBlock = match[1].trim();
    const thought = message.substring(0, match.index || 0).trim();

    return [thought, codeBlock];
  }
}

/**
 * XML thought-action parser
 */
export class XMLThoughtActionParser extends AbstractParseFunction {
  type = 'xml_thought_action';
  errorMessage = `Your output was not formatted correctly. You must always include one discussion and one command as part of your response. Make sure you do not have multiple discussion/command tags.`;

  parse(modelResponse: ModelResponse, _commands: Command[], strict: boolean = false): [string, string] {
    const message = modelResponse.message || '';

    // Find XML command blocks
    const commandPattern = /<command>([\s\S]*?)<\/command>/g;
    const matches = Array.from(message.matchAll(commandPattern));

    if (matches.length === 0) {
      if (strict) {
        throw new FormatError('No <command> tag found in response');
      }
      return [message, ''];
    }

    if (matches.length > 1 && strict) {
      throw new FormatError('Multiple <command> tags found in response');
    }

    const match = matches[0] as RegExpMatchArray;
    const command = match[1].trim();
    const thought = message.substring(0, match.index || 0).trim();

    return [thought, command];
  }
}

/**
 * Function calling parser - expects LiteLLM tool calls
 */
export class FunctionCallingParser extends AbstractParseFunction {
  type = 'function_calling';
  errorMessage = `{%- if error_code == "missing" -%}
Your last output did not use any tool calls!
Please make sure your output includes exactly _ONE_ function call!
{%- elif error_code == "multiple" -%}
Your last output included multiple tool calls!
Please make sure your output includes a thought and exactly _ONE_ function call.
{%- else -%}
Your action could not be parsed properly: {{exception_message}}.
{% endif %}`;

  parse(modelResponse: ModelResponse, commands: Command[], _strict: boolean = false): [string, string] {
    const toolCalls = modelResponse.toolCalls || modelResponse.tool_calls;
    const message = modelResponse.message || '';

    if (!toolCalls || toolCalls.length === 0) {
      throw new FunctionCallingFormatError('No tool calls found', 'missing');
    }

    if (toolCalls.length > 1) {
      throw new FunctionCallingFormatError('Multiple tool calls found', 'multiple');
    }

    const toolCall = toolCalls[0];
    const action = this.parseToolCall(toolCall, commands);

    return [message, action];
  }

  private parseToolCall(
    toolCall: { function?: { name?: string; arguments?: string | Record<string, unknown> } },
    commands: Command[],
  ): string {
    const functionName = toolCall.function?.name;
    const args = toolCall.function?.arguments;

    if (!functionName) {
      throw new FunctionCallingFormatError('No function name in tool call', 'invalid_command');
    }

    // Find the command
    const command = commands.find((cmd) => cmd.name === functionName);
    if (!command) {
      throw new FunctionCallingFormatError(`Unknown command: ${functionName}`, 'invalid_command');
    }

    // Parse arguments
    let parsedArgs: Record<string, unknown> = {};
    if (typeof args === 'string') {
      try {
        parsedArgs = JSON.parse(args);
      } catch {
        throw new FunctionCallingFormatError('Invalid JSON in arguments', 'invalid_json');
      }
    } else if (args) {
      parsedArgs = args;
    }

    // Build command string
    let actionStr = functionName;

    for (const arg of command.arguments) {
      if (arg.required && !(arg.name in parsedArgs)) {
        throw new FunctionCallingFormatError(`Missing required argument: ${arg.name}`, 'missing_arg');
      }

      if (arg.name in parsedArgs) {
        const value = parsedArgs[arg.name];
        actionStr += ` ${this.formatArgValue(value)}`;
      }
    }

    return actionStr;
  }

  private formatArgValue(value: unknown): string {
    if (typeof value === 'string') {
      // Quote if contains spaces or special characters
      if (/[\s"'`$]/.test(value)) {
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return value;
    }
    return String(value);
  }

  formatErrorMessage(error: FunctionCallingFormatError): string {
    // Simple template processing for error messages
    let message = this.errorMessage;

    // Handle conditional blocks based on error code
    const errorCode = error.errorCode || '';

    if (errorCode === 'missing') {
      // Extract the "missing" block
      const missingMatch = message.match(/{%- if error_code == "missing" -%}([\s\S]*?){%- elif/);
      if (missingMatch) {
        message = missingMatch[1].trim();
      }
    } else if (errorCode === 'multiple') {
      // Extract the "multiple" block
      const multipleMatch = message.match(/{%- elif error_code == "multiple" -%}([\s\S]*?){%- else/);
      if (multipleMatch) {
        message = multipleMatch[1].trim();
      }
    } else {
      // Extract the else block
      const elseMatch = message.match(/{%- else -%}([\s\S]*?){% endif %}/);
      if (elseMatch) {
        message = elseMatch[1].trim();
      }
    }

    // Replace template variables
    message = message.replace(/{{exception_message}}/g, error.message);

    return message;
  }
}

/**
 * JSON parser
 */
export class JsonParser extends AbstractParseFunction {
  type = 'json';
  errorMessage = `Your output could not be parsed as JSON. Please make sure your output 1) is valid JSON and 2) Includes the "thought" and "command" fields.`;

  parse(modelResponse: ModelResponse, _commands: Command[], _strict: boolean = false): [string, string] {
    const message = modelResponse.message || '';

    try {
      const parsed = JSON.parse(message);
      const thought = parsed.thought || '';
      const command = parsed.command || parsed.action || '';

      if (!command) {
        throw new FormatError('No command/action field in JSON');
      }

      return [thought, command];
    } catch (error) {
      if (error instanceof FormatError) {
        throw error;
      }
      throw new FormatError('Invalid JSON in response');
    }
  }
}

/**
 * EditFormat parser - expects discussion followed by replacement text in backticks
 */
export class EditFormat extends ThoughtActionParser {
  type = 'edit_format';
  errorMessage = `Your output was not formatted correctly. You must wrap the replacement text in backticks (\`\`\`).
Please make sure your output precisely matches the following format:
COMMENTS
You can write comments here about what you're going to do if you want.

\`\`\`
New window contents.
Make sure you copy the entire contents of the window here, with the required indentation.
Make the changes to the window above directly in this window.
Remember that all of the window's contents will be replaced with the contents of this window.
Don't include line numbers in your response.
\`\`\``;
}

/**
 * Identity parser - returns message as both thought and action
 */
export class Identity extends AbstractParseFunction {
  type = 'identity';
  errorMessage = 'It seems like something went wrong with your output. Please try again.';

  parse(modelResponse: ModelResponse, _commands: Command[], _strict: boolean = false): [string, string] {
    const message = modelResponse.message || '';
    return [message, message];
  }
}

// Export Identity as IdentityParser for backward compatibility
export { Identity as IdentityParser };

/**
 * Parse function type
 */
export type ParseFunction =
  | ActionParser
  | ActionOnlyParser
  | ThoughtActionParser
  | XMLThoughtActionParser
  | FunctionCallingParser
  | JsonParser
  | EditFormat
  | Identity;

/**
 * Create parser from config
 */
export function createParser(config: string | { type: string }): AbstractParseFunction {
  const type = typeof config === 'string' ? config : config.type;

  switch (type) {
    case 'action':
      return new ActionParser();
    case 'action_only':
      return new ActionOnlyParser();
    case 'thought_action':
      return new ThoughtActionParser();
    case 'xml_thought_action':
      return new XMLThoughtActionParser();
    case 'function_calling':
      return new FunctionCallingParser();
    case 'json':
      return new JsonParser();
    case 'edit_format':
      return new EditFormat();
    case 'identity':
      return new Identity();
    default:
      throw new Error(`Unknown parser type: ${type}`);
  }
}
