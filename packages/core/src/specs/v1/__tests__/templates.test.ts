import { describe, expect, it } from 'bun:test';
import { State } from '../state';
import {
  TemplateType,
  TemplateValues,
  createTemplateFunction,
  getTemplateValues,
  processTemplate,
} from '../templates';

// Define a type-safe interface for our test template values
interface UserTemplateValues extends TemplateValues {
  age: number;
  location: string;
  isActive?: boolean;
}

describe('Templates Module', () => {
  describe('TemplateType', () => {
    it('should allow string templates', () => {
      const template: TemplateType = 'Hello, world!';
      expect(typeof template).toBe('string');
    });

    it('should allow function templates', () => {
      const template: TemplateType = ({ state }) => `Hello, ${state.userName}!`;
      expect(typeof template).toBe('function');
    });
  });

  describe('createTemplateFunction', () => {
    it('should handle string templates', () => {
      const template: TemplateType = 'Hello, world!';
      const templateFunction = createTemplateFunction(template);

      const state: State = {
        userId: '12345678-1234-1234-1234-123456789012',
        userName: 'John',
        values: {},
      };

      expect(typeof templateFunction).toBe('function');
      expect(templateFunction(state)).toBe('Hello, world!');
    });

    it('should handle function templates', () => {
      const template: TemplateType = ({ state }) => `Hello, ${state.userName}!`;
      const templateFunction = createTemplateFunction(template);

      const state: State = {
        userId: '12345678-1234-1234-1234-123456789012',
        userName: 'John',
        values: {},
      };

      expect(typeof templateFunction).toBe('function');
      expect(templateFunction(state)).toBe('Hello, John!');
    });

    it('should handle null/undefined state', () => {
      const template: TemplateType = ({ state }) => `Hello, ${state?.userName || 'Guest'}!`;
      const templateFunction = createTemplateFunction(template);

      // @ts-ignore - Testing null state
      const result = templateFunction(null);
      expect(result).toBe('');
    });
  });

  describe('processTemplate', () => {
    it('should process string templates', () => {
      const template: TemplateType = 'Hello, world!';
      const state: State = {
        userId: '12345678-1234-1234-1234-123456789012',
        userName: 'John',
        values: {},
      };

      const result = processTemplate(template, state);
      expect(result).toBe('Hello, world!');
    });

    it('should process function templates', () => {
      const template: TemplateType = ({ state }) => `Hello, ${state.userName}!`;
      const state: State = {
        userId: '12345678-1234-1234-1234-123456789012',
        userName: 'John',
        values: {},
      };

      const result = processTemplate(template, state);
      expect(result).toBe('Hello, John!');
    });

    it('should handle null/undefined templates', () => {
      const state: State = {
        userId: '12345678-1234-1234-1234-123456789012',
        userName: 'John',
        values: {},
      };

      // @ts-ignore - Testing null template
      const result = processTemplate(null, state);
      expect(result).toBe('');
    });

    it('should handle null/undefined state', () => {
      const stringTemplate: TemplateType = 'Static content';
      const fnTemplate: TemplateType = ({ state }) => `Hello, ${state?.userName || 'Guest'}!`;

      // @ts-ignore - Testing null state
      const result1 = processTemplate(stringTemplate, null);
      // @ts-ignore - Testing null state
      const result2 = processTemplate(fnTemplate, null);

      expect(result1).toBe('Static content');
      expect(result2).toBe('');
    });
  });

  describe('getTemplateValues', () => {
    it('should provide type-safe access to state values', () => {
      const state: State = {
        userId: '12345678-1234-1234-1234-123456789012',
        userName: 'John',
        values: {
          age: 30,
          location: 'New York',
          isActive: true,
        },
      };

      const values = getTemplateValues<UserTemplateValues>(state);

      expect(values.age).toBe(30);
      expect(values.location).toBe('New York');
      expect(values.isActive).toBe(true);
    });

    it('should apply default values when properties are missing', () => {
      const state: State = {
        userId: '12345678-1234-1234-1234-123456789012',
        userName: 'John',
        values: {
          // age is missing
          location: 'New York',
        },
      };

      const values = getTemplateValues<UserTemplateValues>(state, {
        age: 25,
        isActive: false,
      });

      expect(values.age).toBe(25); // Default value
      expect(values.location).toBe('New York'); // From state
      expect(values.isActive).toBe(false); // Default value
    });

    it('should handle null/undefined state', () => {
      // @ts-ignore - Testing null state
      const values = getTemplateValues<UserTemplateValues>(null, {
        age: 0,
        location: 'Unknown',
      });

      expect(values.age).toBe(0);
      expect(values.location).toBe('Unknown');
    });

    it('should handle null/undefined values in state', () => {
      const state: State = {
        userId: '12345678-1234-1234-1234-123456789012',
        userName: 'John',
        // values is missing
      };

      const values = getTemplateValues<UserTemplateValues>(state, {
        age: 0,
        location: 'Unknown',
      });

      expect(values.age).toBe(0);
      expect(values.location).toBe('Unknown');
    });
  });

  describe('Integration', () => {
    it('should use getTemplateValues with processTemplate', () => {
      const template: TemplateType = ({ state }) => {
        const values = getTemplateValues<UserTemplateValues>(state, {
          age: 0,
          location: 'Unknown',
        });
        return `User: ${state.userName}, Age: ${values.age}, Location: ${values.location}`;
      };

      const state: State = {
        userId: '12345678-1234-1234-1234-123456789012',
        userName: 'John',
        values: {
          age: 30,
          location: 'New York',
        },
      };

      const result = processTemplate(template, state);
      expect(result).toBe('User: John, Age: 30, Location: New York');
    });
  });
});
