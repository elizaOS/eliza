/**
 * Command definitions for tools
 * Converted from sweagent/tools/commands.py
 */

/**
 * Extract keys from a format string
 */
function extractKeys(formatString: string): Set<string> {
  const keys = new Set<string>();
  // Match both {value} and {{value}} patterns
  const regex = /\{?\{(\w+)\}?\}/g;
  let match;

  while ((match = regex.exec(formatString)) !== null) {
    keys.add(match[1]);
  }

  return keys;
}

/**
 * Command argument definition
 */
export interface IArgument {
  name: string;
  type: string;
  items?: Record<string, string> | null;
  description: string;
  required: boolean;
  enum?: string[] | null;
  argumentFormat: string;
}

/**
 * Command argument implementation
 */
class ArgumentImpl implements IArgument {
  name: string;
  type: string;
  items?: Record<string, string> | null;
  description: string;
  required: boolean;
  enum?: string[] | null;
  argumentFormat: string;

  constructor(config: {
    name: string;
    type: string;
    items?: Record<string, string> | null;
    description: string;
    required: boolean;
    enum?: string[] | null;
    argumentFormat?: string;
  }) {
    this.name = config.name;
    this.type = config.type;
    this.items = config.items || null;
    this.description = config.description;
    this.required = config.required;
    this.enum = config.enum || null;
    this.argumentFormat = config.argumentFormat || '{{value}}';

    this.validateArgumentFormat();
  }

  private validateArgumentFormat(): void {
    const keys = extractKeys(this.argumentFormat);
    if (!keys.has('value')) {
      throw new Error(`Argument format must contain {value} or {{value}} placeholder: ${this.argumentFormat}`);
    }
  }
}

/**
 * Command definition
 */
export class Command {
  name: string;
  docstring: string | null;
  signature: string | null;
  endName?: string;
  arguments: IArgument[];

  constructor(config: {
    name: string;
    docstring?: string | null;
    signature?: string | null;
    endName?: string;
    arguments?: IArgument[];
  }) {
    this.name = config.name;
    this.docstring = config.docstring || null;
    this.signature = config.signature || null;
    this.endName = config.endName;
    this.arguments = config.arguments || [];

    this.validateArguments();
  }

  get invokeFormat(): string {
    // If there's a custom signature, process it
    if (this.signature) {
      // Replace angle brackets (and optional brackets) with curly braces for arguments
      // Handle both <arg> and [<arg>] patterns
      return this.signature.replace(/\[?<([^>]+)>\]?/g, '{$1}');
    }

    // Build the default invocation format string
    let format = this.name + ' ';

    for (const arg of this.arguments) {
      format += `{${arg.name}} `;
    }

    if (this.endName) {
      format += '\n...\n' + this.endName;
    }

    return format;
  }

  getFunctionCallingTool(): Record<string, any> {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const arg of this.arguments) {
      const prop: Record<string, unknown> = {
        type: arg.type,
        description: arg.description,
      };

      if (arg.enum) {
        prop.enum = arg.enum;
      }

      if (arg.items) {
        prop.items = arg.items;
      }

      properties[arg.name] = prop;

      if (arg.required) {
        required.push(arg.name);
      }
    }

    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.docstring || '',
        parameters: {
          type: 'object',
          properties,
          required,
        },
      },
    };
  }

  private validateArguments(): void {
    if (this.arguments.length === 0) {
      return;
    }

    // Check for required arguments after optional ones
    let foundOptional = false;
    for (const arg of this.arguments) {
      if (foundOptional && arg.required) {
        throw new Error(`Command '${this.name}': Required argument '${arg.name}' cannot come after optional arguments`);
      }
      if (!arg.required) {
        foundOptional = true;
      }
    }

    // Check for duplicate argument names
    const argNames = new Set<string>();
    for (const arg of this.arguments) {
      if (argNames.has(arg.name)) {
        throw new Error(`Command '${this.name}': Duplicate argument name: ${arg.name}`);
      }
      argNames.add(arg.name);

      // Validate argument name pattern
      const argNamePattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
      if (!argNamePattern.test(arg.name)) {
        throw new Error(`Command '${this.name}': Invalid argument name: '${arg.name}'`);
      }

      // Validate argument type
      const validTypes = ['string', 'integer', 'number', 'boolean', 'array', 'object'];
      if (!validTypes.includes(arg.type)) {
        throw new Error(`Invalid argument type: ${arg.type}`);
      }
    }

    // If there's a signature, validate that all arguments appear in it
    if (this.signature) {
      for (const arg of this.arguments) {
        const patterns = [`<${arg.name}>`, `[<${arg.name}>]`, `{${arg.name}}`, `--${arg.name}`];
        if (!patterns.some((pattern) => this.signature!.includes(pattern))) {
          throw new Error(`Command '${this.name}': Missing argument ${arg.name} in signature: ${this.signature}`);
        }
      }

      // Check for extra arguments in signature
      const signatureArgMatches = [...this.signature.matchAll(/[<{]([^>}]+)[>}]/g)];
      const signatureArgs = new Set(signatureArgMatches.map((m) => m[1]));
      const definedArgs = new Set(this.arguments.map((arg) => arg.name));

      for (const sigArg of signatureArgs) {
        if (!definedArgs.has(sigArg)) {
          throw new Error(`Command '${this.name}': Argument names in signature do not match arguments list`);
        }
      }
    }
  }
}

// Export ArgumentImpl as Argument for tests that expect it as a class
export { ArgumentImpl as Argument };
