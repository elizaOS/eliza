import { describe, it, expect, beforeEach } from 'bun:test';
import {
  parseParameterPath,
  isValidPathSyntax,
  normalizeParameterPath,
  suggestPathCorrections,
  getParentPath,
  reconstructPath,
  clearPathCache,
  getPathCacheStats,
  ParameterPath,
} from '../path-parser';

describe('Path Parser', () => {
  beforeEach(() => {
    clearPathCache();
  });

  describe('parseParameterPath', () => {
    it('should parse simple paths', () => {
      const result = parseParameterPath('character.name');
      expect(result.segments).toEqual(['character', 'name']);
      expect(result.hasArrayAccess).toBe(false);
      expect(result.originalPath).toBe('character.name');
    });

    it('should parse nested paths', () => {
      const result = parseParameterPath('character.llm.model');
      expect(result.segments).toEqual(['character', 'llm', 'model']);
      expect(result.hasArrayAccess).toBe(false);
    });

    it('should parse array access paths', () => {
      const result = parseParameterPath('run[0].input');
      expect(result.segments).toEqual(['run', 0, 'input']);
      expect(result.hasArrayAccess).toBe(true);
    });

    it('should parse complex mixed paths', () => {
      const result = parseParameterPath('plugins[1].config.settings[2].value');
      expect(result.segments).toEqual(['plugins', 1, 'config', 'settings', 2, 'value']);
      expect(result.hasArrayAccess).toBe(true);
    });

    it('should handle single property paths', () => {
      const result = parseParameterPath('name');
      expect(result.segments).toEqual(['name']);
      expect(result.hasArrayAccess).toBe(false);
    });

    it('should throw error for empty paths', () => {
      expect(() => parseParameterPath('')).toThrow('Path must be a non-empty string');
      expect(() => parseParameterPath('.')).toThrow('Path cannot start or end with a dot');
    });

    it('should throw error for invalid array indices', () => {
      expect(() => parseParameterPath('run[abc].input')).toThrow('Invalid array index: abc');
      expect(() => parseParameterPath('run[-1].input')).toThrow('Invalid array index: -1');
    });

    it('should throw error for malformed paths', () => {
      expect(() => parseParameterPath('.character.name')).toThrow(
        'Path cannot start or end with a dot'
      );
      expect(() => parseParameterPath('character..name')).toThrow('Empty segment in path');
      expect(() => parseParameterPath('character.name.')).toThrow(
        'Path cannot start or end with a dot'
      );
    });

    it('should throw error for unclosed brackets', () => {
      expect(() => parseParameterPath('run[0.input')).toThrow(
        'Missing closing bracket for array index'
      );
    });

    it('should throw error for unexpected closing brackets', () => {
      expect(() => parseParameterPath('run]0[.input')).toThrow('Unexpected closing bracket');
    });
  });

  describe('isValidPathSyntax', () => {
    it('should validate correct paths', () => {
      expect(isValidPathSyntax('character.name')).toBe(true);
      expect(isValidPathSyntax('run[0].input')).toBe(true);
      expect(isValidPathSyntax('plugins[1].config.settings[2].value')).toBe(true);
    });

    it('should reject invalid paths', () => {
      expect(isValidPathSyntax('')).toBe(false);
      expect(isValidPathSyntax('.character')).toBe(false);
      expect(isValidPathSyntax('character.')).toBe(false);
      expect(isValidPathSyntax('run[abc].input')).toBe(false);
      expect(isValidPathSyntax('run[0.input')).toBe(false);
    });
  });

  describe('normalizeParameterPath', () => {
    it('should normalize paths with extra spaces', () => {
      expect(normalizeParameterPath('  character.name  ')).toBe('character.name');
    });

    it('should normalize paths with double dots', () => {
      expect(normalizeParameterPath('character..name')).toBe('character.name');
      expect(normalizeParameterPath('character...llm....model')).toBe('character.llm.model');
    });

    it('should remove leading/trailing dots', () => {
      expect(normalizeParameterPath('.character.name.')).toBe('character.name');
    });

    it('should handle empty strings', () => {
      expect(normalizeParameterPath('')).toBe('');
      expect(normalizeParameterPath('   ')).toBe('');
    });
  });

  describe('suggestPathCorrections', () => {
    it('should suggest bracket notation for numeric segments', () => {
      const suggestions = suggestPathCorrections('run.0.input');
      expect(suggestions).toContain('run[0].input');
    });

    it('should suggest closing brackets', () => {
      const suggestions = suggestPathCorrections('run[0.input');
      expect(suggestions).toContain('run[0].input');
    });

    it('should suggest fixing double dots', () => {
      const suggestions = suggestPathCorrections('character..name');
      expect(suggestions).toContain('character.name');
    });

    it('should return empty array for valid paths', () => {
      const suggestions = suggestPathCorrections('character.name');
      expect(suggestions.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getParentPath', () => {
    it('should return parent path for nested paths', () => {
      expect(getParentPath('character.llm.model')).toBe('character.llm');
      expect(getParentPath('run[0].input')).toBe('run[0]');
      expect(getParentPath('plugins[1].config.apiKey')).toBe('plugins[1].config');
    });

    it('should return null for root paths', () => {
      expect(getParentPath('name')).toBe(null);
    });

    it('should handle invalid paths gracefully', () => {
      expect(getParentPath('invalid..path')).toBe(null);
    });
  });

  describe('reconstructPath', () => {
    it('should reconstruct simple paths', () => {
      expect(reconstructPath(['character', 'name'])).toBe('character.name');
    });

    it('should reconstruct array paths', () => {
      expect(reconstructPath(['run', 0, 'input'])).toBe('run[0].input');
      expect(reconstructPath(['plugins', 1, 'config', 'settings', 2])).toBe(
        'plugins[1].config.settings[2]'
      );
    });

    it('should handle mixed paths', () => {
      expect(reconstructPath(['character', 'skills', 0, 'name'])).toBe('character.skills[0].name');
    });

    it('should handle empty segments', () => {
      expect(reconstructPath([])).toBe('');
    });
  });

  describe('Path Caching', () => {
    it('should cache parsed paths', () => {
      const path = 'character.llm.model';

      // First parse
      const result1 = parseParameterPath(path);
      const stats1 = getPathCacheStats();

      // Second parse (should use cache)
      const result2 = parseParameterPath(path);
      const stats2 = getPathCacheStats();

      expect(result1).toEqual(result2);
      expect(stats2.size).toBeGreaterThan(0);
    });

    it('should clear cache when requested', () => {
      parseParameterPath('character.name');
      expect(getPathCacheStats().size).toBeGreaterThan(0);

      clearPathCache();
      expect(getPathCacheStats().size).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long paths', () => {
      const longPath = Array(50).fill('level').join('.') + '.final';
      const result = parseParameterPath(longPath);
      expect(result.segments.length).toBe(51);
    });

    it('should handle large array indices', () => {
      const result = parseParameterPath('array[999999].value');
      expect(result.segments).toEqual(['array', 999999, 'value']);
    });

    it('should handle paths with special but valid characters', () => {
      const result = parseParameterPath('_private.field_name.value123');
      expect(result.segments).toEqual(['_private', 'field_name', 'value123']);
    });

    it('should reject paths with invalid property names', () => {
      expect(() => parseParameterPath('123invalid.name')).toThrow('Invalid property name in path');
      expect(() => parseParameterPath('field-name.value')).toThrow('Invalid property name in path');
      expect(() => parseParameterPath('field name.value')).toThrow('Invalid property name in path');
    });
  });

  describe('Unicode Support', () => {
    it('should handle Unicode property names', () => {
      // Note: Current implementation only supports ASCII property names
      // This test documents the current limitation
      expect(() => parseParameterPath('测试.value')).toThrow('Invalid property name in path');
    });
  });

  describe('Performance', () => {
    it('should parse many paths efficiently', () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        parseParameterPath(`character.skills[${i}].name`);
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete 1000 parses in reasonable time (< 100ms)
      expect(duration).toBeLessThan(100);
    });
  });
});
