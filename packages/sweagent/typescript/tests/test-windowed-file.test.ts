/**
 * Windowed file tests converted from test_default_utils.py
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WindowedFile } from '../src/tools/windowed-file';

describe('WindowedFile', () => {
  let tmpDir: string;
  let testFile: string;
  let envFile: string;
  let windowedFile: any; // Using any to avoid typing issues with mock

  beforeEach(() => {
    // Create temporary directory and files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-windowed-'));
    testFile = path.join(tmpDir, 'test.py');
    envFile = path.join(tmpDir, '.swe-agent-env');

    // Set environment variable for registry
    process.env.SWE_AGENT_ENV_FILE = envFile;

    // Create test file with numbered lines
    const content = Array.from({ length: 100 }, (_, i) => String(i)).join('\n');
    fs.writeFileSync(testFile, content);

    // Initialize registry with test values
    const registryData = {
      CURRENT_FILE: testFile,
      FIRST_LINE: '0',
      WINDOW: '10',
    };
    fs.writeFileSync(envFile, JSON.stringify(registryData));

    // Create windowed file instance
    windowedFile = new WindowedFile({
      path: testFile,
      exitOnException: false,
    });
    windowedFile.offsetMultiplier = 0.25; // 1/4
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
    delete process.env.SWE_AGENT_ENV_FILE;
  });

  describe('Basic operations', () => {
    it('should initialize with correct properties', () => {
      expect(windowedFile.firstLine).toBe(0);
      expect(windowedFile.window).toBe(10);
      expect(windowedFile.nLines).toBe(100);
    });

    it('should calculate line range correctly', () => {
      windowedFile.firstLine = 10;
      const [start, end] = windowedFile.lineRange;
      expect(end - start).toBe(windowedFile.window - 1);
      expect(windowedFile.lineRange).toEqual([10, 19]);
    });

    it('should get window text', () => {
      windowedFile.firstLine = 10;
      const windowText = windowedFile.getWindowText();
      expect(windowText).toContain('10');
      expect(windowText).toContain('19');
    });
  });

  describe('Text replacement', () => {
    it('should replace text in window', () => {
      windowedFile.firstLine = 10;
      windowedFile.replaceInWindow('10', 'Hello, world!');

      expect(windowedFile.nLines).toBe(100);
      expect(windowedFile.lineRange).toEqual([7, 16]);

      const windowText = windowedFile.getWindowText();
      expect(windowText).toContain('Hello, world!');
    });

    it('should handle multiple replacements', () => {
      windowedFile.firstLine = 50;
      windowedFile.replaceInWindow('50', 'Hello, world!');

      // Line 50 is now the 2nd line of the new window
      expect(windowedFile.lineRange).toEqual([47, 56]);

      const windowText = windowedFile.getWindowText();
      expect(windowText).toContain('Hello, world!');
    });

    it('should throw error when text not found', () => {
      expect(() => {
        windowedFile.replaceInWindow('asdf', 'Hello, world!');
      }).toThrow('Text not found');
    });
  });

  describe('Navigation', () => {
    it('should goto line correctly', () => {
      windowedFile.goto(0, 'top');
      expect(windowedFile.lineRange[0]).toBe(0);

      windowedFile.goto(50, 'top');
      // first line is 50 - floor(10/4) = 50 - 2 = 48
      expect(windowedFile.lineRange[0]).toBe(48);

      windowedFile.goto(100, 'top');
      expect(windowedFile.lineRange[1]).toBe(99);
    });

    it('should scroll correctly', () => {
      windowedFile.firstLine = 10;

      windowedFile.scroll(10);
      expect(windowedFile.firstLine).toBe(20);

      windowedFile.scroll(-10);
      expect(windowedFile.firstLine).toBe(10);

      windowedFile.scroll(-100);
      expect(windowedFile.firstLine).toBe(0);

      windowedFile.scroll(100);
      expect(windowedFile.lineRange[1]).toBe(99);
    });
  });

  describe('Window output', () => {
    it('should print window with correct format', () => {
      windowedFile.firstLine = 10;
      const output = windowedFile.getWindowText(true, true, true);

      expect(output).toContain(`[File: ${testFile} (100 lines total)]`);
      expect(output).toContain('(10 more lines above)');
      expect(output).toContain('11:10');
      expect(output).toContain('20:19');
      expect(output).toContain('(80 more lines below)');
    });

    it('should handle new file with single line', () => {
      const newFile = path.join(tmpDir, 'new.py');
      fs.writeFileSync(newFile, '\n');

      const registryData = {
        CURRENT_FILE: newFile,
        FIRST_LINE: '0',
        WINDOW: '10',
      };
      fs.writeFileSync(envFile, JSON.stringify(registryData));

      const newWindowedFile = new WindowedFile({
        path: newFile,
        exitOnException: false,
      });

      expect(newWindowedFile.nLines).toBe(1);
      expect(newWindowedFile.lineRange).toEqual([0, 0]);

      const output = newWindowedFile.getWindowText(true, true, true);
      expect(output).toContain(`[File: ${newFile} (1 lines total)]`);
      expect(output).toContain('1:');
    });
  });

  describe('Text operations', () => {
    it('should find all occurrences', () => {
      const content = 'test\ntest\nother\ntest';
      fs.writeFileSync(testFile, content);

      const wf = new WindowedFile({
        path: testFile,
        exitOnException: false,
      });

      const occurrences = wf.findAllOccurrences('test', false);
      expect(occurrences).toEqual([1, 2, 4]); // 1-based line numbers

      const zeroBasedOccurrences = wf.findAllOccurrences('test', true);
      expect(zeroBasedOccurrences).toEqual([0, 1, 3]); // 0-based line numbers
    });

    it('should handle global replacement', () => {
      const content = 'old\nold\nother\nold';
      fs.writeFileSync(testFile, content);

      const wf = new WindowedFile({
        path: testFile,
        exitOnException: false,
      });

      const info = wf.replace('old', 'new');

      expect(info.nReplacements).toBe(3);
      expect(info.firstReplacedLine).toBe(1);

      const newContent = fs.readFileSync(testFile, 'utf-8');
      expect(newContent).toBe('new\nnew\nother\nnew');
    });

    it('should handle insertion', () => {
      const content = 'line1\nline2\nline3';
      fs.writeFileSync(testFile, content);

      const wf = new WindowedFile({
        path: testFile,
        exitOnException: false,
      });

      // Insert at specific line
      const info = wf.insert('inserted', 1);

      expect(info.firstInsertedLine).toBe(1);
      expect(info.nLinesAdded).toBe(1);

      const newContent = fs.readFileSync(testFile, 'utf-8');
      expect(newContent).toBe('line1\ninserted\nline2\nline3');
    });

    it('should undo edits', () => {
      const originalContent = 'original';
      fs.writeFileSync(testFile, originalContent);

      const wf = new WindowedFile({
        path: testFile,
        exitOnException: false,
      });

      // Make an edit
      wf.replace('original', 'modified');
      expect(fs.readFileSync(testFile, 'utf-8')).toBe('modified');

      // Undo the edit
      wf.undoEdit();
      expect(fs.readFileSync(testFile, 'utf-8')).toBe(originalContent);
    });
  });
});
