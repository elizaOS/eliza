/**
 * Parsing tests converted from test_parsing.py
 */

import { describe, it, expect } from '@jest/globals';
import {
  ActionOnlyParser as ActionParser,
  EditFormatParser as EditFormat,
  FunctionCallingParser,
  Identity,
  JsonParser,
  ThoughtActionParser,
  XMLThoughtActionParser,
} from '../src/agent/tools/parsing';
import { Command } from '../src/agent/types';
import { FormatError, FunctionCallingFormatError } from '../src/exceptions';

describe('Parsing', () => {
  describe('ActionParser', () => {
    it('should parse valid commands', () => {
      const parser = new ActionParser();
      const command: Command = {
        name: 'ls',
      };

      const [thought, action] = parser.parse({ message: 'ls -l' }, [command]);

      expect(thought).toBe('');
      expect(action).toBe('ls -l');
    });

    it('should throw FormatError for invalid commands', () => {
      const parser = new ActionParser();
      const command: Command = {
        name: 'ls',
      };

      expect(() => {
        parser.parse({ message: 'invalid command' }, [command]);
      }).toThrow(FormatError);
    });
  });

  describe('ThoughtActionParser', () => {
    it('should parse thought and action with code blocks', () => {
      const parser = new ThoughtActionParser();
      const modelResponse = "Let's look at the files in the current directory.\n```\nls -l\n```";

      const [thought, action] = parser.parse({ message: modelResponse }, []);

      expect(thought).toBe("Let's look at the files in the current directory.\n");
      expect(action).toBe('ls -l\n');
    });

    it('should throw FormatError when no code block', () => {
      const parser = new ThoughtActionParser();

      expect(() => {
        parser.parse({ message: 'No code block' }, []);
      }).toThrow(FormatError);
    });
  });

  describe('XMLThoughtActionParser', () => {
    it('should parse XML command tags', () => {
      const parser = new XMLThoughtActionParser();
      const modelResponse = "Let's look at the files in the current directory.\n<command>\nls -l\n</command>";

      const [thought, action] = parser.parse({ message: modelResponse }, []);

      expect(thought).toBe("Let's look at the files in the current directory.");
      expect(action).toBe('ls -l');
    });

    it('should throw FormatError when no command tags', () => {
      const parser = new XMLThoughtActionParser();

      expect(() => {
        parser.parse({ message: 'No command tags' }, []);
      }).toThrow(FormatError);
    });
  });

  describe('EditFormat', () => {
    it('should parse edit format with code blocks', () => {
      const parser = new EditFormat();
      const modelResponse = "Let's replace the contents.\n```\nimport os\nos.listdir()\n```";

      const [thought, action] = parser.parse({ message: modelResponse }, []);

      expect(thought).toBe("Let's replace the contents.\n");
      expect(action).toBe('import os\nos.listdir()\n');
    });

    it('should throw FormatError when no code block', () => {
      const parser = new EditFormat();

      expect(() => {
        parser.parse({ message: 'No code block' }, []);
      }).toThrow(FormatError);
    });
  });

  describe('Identity', () => {
    it('should return input as is', () => {
      const parser = new Identity();
      const modelResponse = 'Return as is';

      const [thought, action] = parser.parse({ message: modelResponse }, []);

      expect(thought).toBe(modelResponse);
      expect(action).toBe(modelResponse);
    });
  });

  describe('JsonParser', () => {
    it('should parse valid JSON', () => {
      const parser = new JsonParser();
      const modelResponse = '{"thought": "List files", "command": {"name": "ls", "arguments": {"path": "."}}}';

      const [thought, action] = parser.parse({ message: modelResponse }, []);

      expect(thought).toBe('List files');
      expect(action).toBe('ls .');
    });

    it('should throw FormatError for invalid JSON', () => {
      const parser = new JsonParser();

      expect(() => {
        parser.parse({ message: 'Not a JSON' }, []);
      }).toThrow(FormatError);
    });

    it('should throw FormatError for missing keys', () => {
      const parser = new JsonParser();
      const missingKeys = '{"thought": "Missing command key"}';

      expect(() => {
        parser.parse({ message: missingKeys }, []);
      }).toThrow(FormatError);
    });
  });

  describe('FunctionCallingParser', () => {
    it('should parse function calls successfully', () => {
      const parser = new FunctionCallingParser();
      const command: Command = {
        name: 'ls',
      };

      const modelResponse = {
        message: "Let's list the files",
        tool_calls: [
          {
            function: {
              name: 'ls',
              arguments: '{}',
            },
          },
        ],
      };

      const [thought, action] = parser.parse(modelResponse, [command]);

      expect(thought).toBe("Let's list the files");
      expect(action).toBe('ls');
    });

    it('should throw error for missing tool_calls', () => {
      const parser = new FunctionCallingParser();
      const command: Command = {
        name: 'ls',
      };

      expect(() => {
        parser.parse({ message: 'No tool calls' }, [command]);
      }).toThrow(FormatError);
    });

    it('should throw error for multiple tool calls', () => {
      const parser = new FunctionCallingParser();
      const command: Command = {
        name: 'ls',
      };

      const multipleCalls = {
        message: 'Multiple calls',
        tool_calls: [{ function: { name: 'ls', arguments: '{}' } }, { function: { name: 'cd', arguments: '{}' } }],
      };

      expect(() => {
        parser.parse(multipleCalls, [command]);
      }).toThrow(FormatError);
    });

    it('should throw error for invalid command', () => {
      const parser = new FunctionCallingParser();
      const command: Command = {
        name: 'ls',
      };

      const invalidCommand = {
        message: 'Invalid command',
        tool_calls: [
          {
            function: {
              name: 'invalid',
              arguments: '{}',
            },
          },
        ],
      };

      expect(() => {
        parser.parse(invalidCommand, [command]);
      }).toThrow(FormatError);
    });

    it('should throw error for invalid JSON arguments', () => {
      const parser = new FunctionCallingParser();
      const command: Command = {
        name: 'ls',
      };

      const invalidJson = {
        message: 'Invalid JSON',
        tool_calls: [
          {
            function: {
              name: 'ls',
              arguments: 'invalid json',
            },
          },
        ],
      };

      expect(() => {
        parser.parse(invalidJson, [command]);
      }).toThrow(FormatError);
    });
  });

  describe('FunctionCallingParser error messages', () => {
    it('should format error message correctly', () => {
      const parser = new FunctionCallingParser();
      const error = new FunctionCallingFormatError('test', 'missing');
      const message = parser.formatErrorMessage(error);

      expect(message).toContain('did not use any tool calls');
    });
  });
});
