/**
 * Tests for default utils (WindowedFile)
 * Converted from tests/tools/test_default_utils.py
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { WindowedFile, TextNotFound } from '../src/tools/windowed-file';
import { withTmpEnvFile, createTestFileWithContent } from './test-fixtures';

describe('Default Utils - WindowedFile', () => {
  let fixture: ReturnType<typeof withTmpEnvFile>;

  beforeEach(() => {
    fixture = withTmpEnvFile();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('should verify env file override', () => {
    expect(process.env.SWE_AGENT_ENV_FILE).toBe(fixture.envFile);
    expect(path.basename(fixture.envFile)).toBe('.swe-agent-env');
  });

  describe('WindowedFile operations', () => {
    let windowedFile: WindowedFile;
    let testPath: string;

    beforeEach(() => {
      // Create test file with numbered lines (0-99)
      const content = Array.from({ length: 100 }, (_, i) => String(i)).join('\n');
      const result = createTestFileWithContent(fixture.envFile, content);
      testPath = result.testPath;

      // Create WindowedFile instance
      windowedFile = new WindowedFile({
        exitOnException: false,
        path: testPath,
      });
      windowedFile.offsetMultiplier = 0.25; // 1/4
    });

    it('should initialize with correct values', () => {
      expect(windowedFile.firstLine).toBe(0);
      expect(windowedFile.window).toBe(10);
      expect(windowedFile.nLines).toBe(100);
    });

    it('should calculate line range correctly', () => {
      expect(windowedFile.lineRange).toEqual([0, 9]);

      windowedFile.firstLine = 10;
      expect(windowedFile.lineRange).toEqual([10, 19]);

      windowedFile.firstLine = 95;
      expect(windowedFile.lineRange).toEqual([95, 99]);
    });

    it('should replace text in window', () => {
      windowedFile.firstLine = 10;
      expect(windowedFile.lineRange).toEqual([10, 19]);

      // Replace "10" with "Hello, world!"
      windowedFile.replaceInWindow('10', 'Hello, world!');

      // After replacement, window should adjust
      expect(windowedFile.nLines).toBe(100);
      // Window adjusts to center on replacement
      expect(windowedFile.lineRange[0]).toBeLessThan(10);

      // Verify file was updated
      const content = fs.readFileSync(testPath, 'utf-8');
      expect(content).toContain('Hello, world!');
      expect(content).not.toContain('10\n11');
    });

    it('should throw TextNotFound for non-existent text', () => {
      windowedFile.firstLine = 10;

      expect(() => {
        windowedFile.replaceInWindow('asdf', 'Hello, world!');
      }).toThrow(TextNotFound);
    });

    it('should handle goto with top mode', () => {
      windowedFile.goto(0, 'top');
      expect(windowedFile.lineRange[0]).toBe(0);

      windowedFile.goto(50, 'top');
      // With offset of 0.25 * 10 = 2.5 -> 2
      // firstLine should be 50 - 2 = 48
      expect(windowedFile.lineRange[0]).toBe(48);

      windowedFile.goto(100, 'top');
      // Should not exceed file bounds
      expect(windowedFile.lineRange[1]).toBe(99);
    });

    it('should handle scrolling', () => {
      windowedFile.firstLine = 10;

      windowedFile.scroll(10);
      expect(windowedFile.firstLine).toBe(20);

      windowedFile.scroll(-10);
      expect(windowedFile.firstLine).toBe(10);

      windowedFile.scroll(-100);
      // Can't go below 0
      expect(windowedFile.firstLine).toBe(0);

      windowedFile.scroll(100);
      // Should stay within bounds
      expect(windowedFile.lineRange[1]).toBe(99);
    });

    it('should print window correctly', () => {
      windowedFile.firstLine = 10;

      // Capture console output
      const originalLog = console.log;
      const output: string[] = [];
      console.log = (msg: string) => output.push(msg);

      try {
        windowedFile.printWindow();

        // Check output format
        expect(output[0]).toContain(`[File: ${path.resolve(testPath)} (100 lines total)]`);
        expect(output[1]).toContain('(10 more lines above)');
        expect(output[2]).toBe('11:10'); // Line 11 contains "10"
        expect(output[3]).toBe('12:11');
        expect(output[output.length - 1]).toContain('(80 more lines below)');
      } finally {
        console.log = originalLog;
      }
    });

    it('should handle new file with single empty line', () => {
      const newFilePath = path.join(fixture.tmpDir, 'new.py');
      fs.writeFileSync(newFilePath, '\n', 'utf-8');

      const newFile = new WindowedFile({
        exitOnException: false,
        path: newFilePath,
      });

      expect(newFile.nLines).toBe(1);
      expect(newFile.lineRange).toEqual([0, 0]);

      // Capture console output
      const originalLog = console.log;
      const output: string[] = [];
      console.log = (msg: string) => output.push(msg);

      try {
        newFile.printWindow();

        expect(output[0]).toContain(`[File: ${path.resolve(newFilePath)} (1 lines total)]`);
        expect(output[1]).toBe('1:'); // Line 1 is empty
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('Multiple replacements', () => {
    let windowedFile: WindowedFile;
    let testPath: string;

    beforeEach(() => {
      // Create test file with numbered lines
      const content = Array.from({ length: 100 }, (_, i) => String(i)).join('\n');
      const result = createTestFileWithContent(fixture.envFile, content);
      testPath = result.testPath;

      windowedFile = new WindowedFile({
        exitOnException: false,
        path: testPath,
      });
      windowedFile.offsetMultiplier = 0.25;
    });

    it('should handle multiple replacements', () => {
      windowedFile.firstLine = 10;

      // First replacement
      windowedFile.replaceInWindow('10', 'Hello, world!');
      expect(windowedFile.nLines).toBe(100);

      // Move to line 50
      windowedFile.firstLine = 50;

      // Second replacement
      windowedFile.replaceInWindow('50', 'Hello, world!');

      // Verify both replacements
      const content = fs.readFileSync(testPath, 'utf-8');
      const lines = content.split('\n');

      // Find the replaced lines
      const helloLines = lines
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => line === 'Hello, world!')
        .map(({ idx }) => idx);

      expect(helloLines.length).toBe(2);
    });
  });
});
