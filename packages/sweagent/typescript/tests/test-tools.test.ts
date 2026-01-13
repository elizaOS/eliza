/**
 * Tools tests converted from test_tools_command_parsing.py
 */

import { describe, it, expect } from '@jest/globals';
import { Command, Argument } from '../src/tools/commands';

describe('Command Parsing', () => {
  describe('Signature formats', () => {
    it('should handle default format with no signature', () => {
      const command = new Command({
        name: 'test_cmd',
        docstring: 'A test command',
        arguments: [
          new Argument({
            name: 'arg1',
            type: 'string',
            description: 'First argument',
            required: true,
          }),
          new Argument({
            name: 'arg2',
            type: 'integer',
            description: 'Second argument',
            required: false,
          }),
        ],
      });

      expect(command.invokeFormat).toBe('test_cmd {arg1} {arg2} ');
    });

    it('should handle angle brackets', () => {
      const command = new Command({
        name: 'goto',
        signature: 'goto <line_number>',
        docstring: 'moves the window to show line_number',
        arguments: [
          new Argument({
            name: 'line_number',
            type: 'integer',
            description: 'line number',
            required: true,
          }),
        ],
      });

      expect(command.invokeFormat).toBe('goto {line_number}');
    });

    it('should handle optional brackets', () => {
      const command = new Command({
        name: 'open',
        signature: 'open "<path>" [<line_number>]',
        docstring: 'opens file at path',
        arguments: [
          new Argument({
            name: 'path',
            type: 'string',
            description: 'file path',
            required: true,
          }),
          new Argument({
            name: 'line_number',
            type: 'integer',
            description: 'line number',
            required: false,
          }),
        ],
      });

      expect(command.invokeFormat).toBe('open "{path}" {line_number}');
    });

    it('should handle flag-style arguments', () => {
      const command = new Command({
        name: 'grep',
        signature: 'grep --pattern <pattern> --file <file>',
        docstring: 'search for pattern in file',
        arguments: [
          new Argument({
            name: 'pattern',
            type: 'string',
            description: 'search pattern',
            required: true,
          }),
          new Argument({
            name: 'file',
            type: 'string',
            description: 'file to search',
            required: true,
          }),
        ],
      });

      expect(command.invokeFormat).toBe('grep --pattern {pattern} --file {file}');
    });

    it('should handle no arguments', () => {
      const command = new Command({
        name: 'scroll_up',
        signature: 'scroll_up',
        docstring: 'scrolls up',
        arguments: [],
      });

      expect(command.invokeFormat).toBe('scroll_up');
    });
  });

  describe('Argument validation', () => {
    it('should require required arguments before optional ones', () => {
      expect(() => {
        new Command({
          name: 'bad_order',
          docstring: 'bad argument order',
          arguments: [
            new Argument({
              name: 'optional',
              type: 'string',
              description: 'optional',
              required: false,
            }),
            new Argument({
              name: 'required',
              type: 'string',
              description: 'required',
              required: true,
            }),
          ],
        });
      }).toThrow(/Required argument.*cannot come after optional arguments/);
    });

    it('should not allow duplicate argument names', () => {
      expect(() => {
        new Command({
          name: 'duplicate',
          docstring: 'duplicate args',
          arguments: [
            new Argument({
              name: 'arg1',
              type: 'string',
              description: 'first',
              required: true,
            }),
            new Argument({
              name: 'arg1',
              type: 'string',
              description: 'duplicate',
              required: true,
            }),
          ],
        });
      }).toThrow(/Duplicate argument name/);
    });
  });

  describe('Argument name patterns', () => {
    it('should accept valid argument names', () => {
      const validNames = [
        'a',
        'x',
        'n',
        'simple',
        'with_underscore',
        'with-dash',
        'with123numbers',
        '_starts_with_underscore',
      ];

      validNames.forEach((name) => {
        const command = new Command({
          name: 'test',
          docstring: 'test',
          arguments: [
            new Argument({
              name,
              type: 'string',
              description: 'test',
              required: true,
            }),
          ],
        });

        expect(command.arguments[0].name).toBe(name);
      });
    });

    it('should reject invalid argument names', () => {
      const invalidNames = ['123starts_with_number', ''];

      invalidNames.forEach((name) => {
        expect(() => {
          new Command({
            name: 'test',
            docstring: 'test',
            arguments: [
              new Argument({
                name,
                type: 'string',
                description: 'test',
                required: true,
              }),
            ],
          });
        }).toThrow(/Invalid argument name/);
      });
    });
  });

  describe('Signature and argument consistency', () => {
    it('should require all arguments to appear in signature', () => {
      expect(() => {
        new Command({
          name: 'missing_arg',
          signature: 'missing_arg <existing_arg>',
          docstring: 'missing argument in signature',
          arguments: [
            new Argument({
              name: 'existing_arg',
              type: 'string',
              description: 'exists',
              required: true,
            }),
            new Argument({
              name: 'missing_arg',
              type: 'string',
              description: 'not in signature',
              required: true,
            }),
          ],
        });
      }).toThrow(/Missing argument.*in signature/);
    });

    it('should reject extra arguments in signature', () => {
      expect(() => {
        new Command({
          name: 'extra_arg',
          signature: 'extra_arg <arg1> <extra>',
          docstring: 'extra argument in signature',
          arguments: [
            new Argument({
              name: 'arg1',
              type: 'string',
              description: 'exists',
              required: true,
            }),
          ],
        });
      }).toThrow(/Argument names.*do not match/);
    });
  });

  describe('Function calling tool generation', () => {
    it('should generate OpenAI function calling tool', () => {
      const command = new Command({
        name: 'test_function',
        docstring: 'A test function for OpenAI',
        arguments: [
          new Argument({
            name: 'required_arg',
            type: 'string',
            description: 'Required string argument',
            required: true,
          }),
          new Argument({
            name: 'enum_arg',
            type: 'string',
            description: 'Enum argument',
            required: true,
            enum: ['option1', 'option2'],
          }),
          new Argument({
            name: 'optional_arg',
            type: 'integer',
            description: 'Optional integer argument',
            required: false,
          }),
        ],
      });

      const tool = command.getFunctionCallingTool();

      expect(tool.type).toBe('function');
      expect(tool.function.name).toBe('test_function');
      expect(tool.function.description).toBe('A test function for OpenAI');

      const properties = tool.function.parameters.properties;
      expect(properties.required_arg.type).toBe('string');
      expect(properties.optional_arg.type).toBe('integer');
      expect(properties.enum_arg.enum).toEqual(['option1', 'option2']);

      const required = tool.function.parameters.required;
      expect(required).toContain('required_arg');
      expect(required).toContain('enum_arg');
      expect(required).not.toContain('optional_arg');
    });
  });

  describe('Multi-line commands', () => {
    it('should handle commands with end markers', () => {
      const command = new Command({
        name: 'edit',
        signature: 'edit <filename>',
        docstring: 'Edit a file with multi-line content',
        endName: 'EOF',
        arguments: [
          new Argument({
            name: 'filename',
            type: 'string',
            description: 'file to edit',
            required: true,
          }),
        ],
      });

      expect(command.invokeFormat).toBe('edit {filename}');
      expect(command.endName).toBe('EOF');
    });
  });

  describe('Custom argument format', () => {
    it('should handle custom argument formatting', () => {
      const command = new Command({
        name: 'custom_format',
        docstring: 'Test custom argument formatting',
        arguments: [
          new Argument({
            name: 'arg1',
            type: 'string',
            description: 'Custom formatted argument',
            required: true,
            argumentFormat: '--{value}',
          }),
        ],
      });

      expect(command.arguments[0].argumentFormat).toBe('--{value}');
      expect(command.invokeFormat).toBe('custom_format {arg1} ');
    });
  });
});
