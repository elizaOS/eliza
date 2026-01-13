/**
 * Integration tests for all Node.js tools
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Tools Integration Tests', () => {
  let tmpDir: string;
  const toolsDir = path.join(__dirname, '..', 'tools');

  beforeAll(() => {
    // Create temp directory for testing
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-test-'));

    // Build tools if not already built
    if (!fs.existsSync(path.join(toolsDir, 'dist'))) {
      console.log('Building tools...');
      execSync('npm run build', { cwd: toolsDir });
    }
  });

  afterAll(() => {
    // Clean up temp directory
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  describe('Registry Tool', () => {
    const registryPath = path.join(toolsDir, 'bin', 'registry');

    it('should set and get values', () => {
      process.env.SWE_AGENT_ENV_FILE = path.join(tmpDir, 'test-env.json');

      // Set a value
      execSync(`${registryPath} set TEST_VAR "test value"`);

      // Get the value
      const result = execSync(`${registryPath} get TEST_VAR`).toString().trim();
      expect(result).toBe('test value');

      delete process.env.SWE_AGENT_ENV_FILE;
    });

    it('should handle _read_env and _write_env', () => {
      process.env.SWE_AGENT_ENV_FILE = path.join(tmpDir, 'test-env2.json');

      const writeEnv = path.join(toolsDir, 'bin', '_write_env');
      const readEnv = path.join(toolsDir, 'bin', '_read_env');

      // Write a value
      execSync(`${writeEnv} MY_VAR "my value"`);

      // Read the value
      const result = execSync(`${readEnv} MY_VAR`).toString().trim();
      expect(result).toBe('my value');

      // Read with default
      const resultWithDefault = execSync(`${readEnv} NONEXISTENT "default"`).toString().trim();
      expect(resultWithDefault).toBe('default');

      delete process.env.SWE_AGENT_ENV_FILE;
    });
  });

  describe('Search Tools', () => {
    let testFile: string;

    beforeAll(() => {
      testFile = path.join(tmpDir, 'search-test.txt');
      fs.writeFileSync(testFile, 'line one\nline two with test\nline three\ntest line four');
    });

    it('should search within file', () => {
      const searchFile = path.join(toolsDir, 'bin', 'search_file');
      const result = execSync(`${searchFile} test ${testFile}`).toString();

      expect(result).toContain('Found');
      expect(result).toContain('matches for "test"');
      expect(result).toContain('line two with test');
      expect(result).toContain('test line four');
    });

    it('should find files by pattern', () => {
      const findFile = path.join(toolsDir, 'bin', 'find_file');

      // Create test files
      fs.writeFileSync(path.join(tmpDir, 'test1.txt'), 'content');
      fs.writeFileSync(path.join(tmpDir, 'test2.txt'), 'content');
      fs.writeFileSync(path.join(tmpDir, 'other.md'), 'content');

      const result = execSync(`${findFile} "*.txt" ${tmpDir}`).toString();

      expect(result).toContain('test1.txt');
      expect(result).toContain('test2.txt');
      expect(result).not.toContain('other.md');
    });

    it('should search directory', () => {
      const searchDir = path.join(toolsDir, 'bin', 'search_dir');

      // Create test files with content
      fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'contains search term');
      fs.writeFileSync(path.join(tmpDir, 'file2.txt'), 'also has search in it');
      fs.writeFileSync(path.join(tmpDir, 'file3.txt'), 'nothing here');

      const result = execSync(`${searchDir} search ${tmpDir}`).toString();

      expect(result).toContain('file1.txt');
      expect(result).toContain('file2.txt');
      expect(result).not.toContain('file3.txt');
    });
  });

  describe('Image Tools', () => {
    it('should convert image to base64', () => {
      const viewImage = path.join(toolsDir, 'bin', 'view_image');

      // Create a simple 1x1 PNG
      const pngData = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      );
      const imagePath = path.join(tmpDir, 'test.png');
      fs.writeFileSync(imagePath, pngData);

      const result = execSync(`${viewImage} ${imagePath}`).toString();

      expect(result).toContain('![');
      expect(result).toContain('](data:image/png;base64,');
    });
  });

  describe('Submit Tool', () => {
    it('should create submission markers', () => {
      const submit = path.join(toolsDir, 'bin', 'submit');

      // Set up git repo
      process.env.ROOT = tmpDir;
      execSync('git init', { cwd: tmpDir });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir });
      execSync('git config user.name "Test User"', { cwd: tmpDir });

      // Create and add a file
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'test content');
      execSync('git add .', { cwd: tmpDir });

      const result = execSync(submit, { maxBuffer: 10 * 1024 * 1024 }).toString();

      expect(result).toContain('<<SWE_AGENT_SUBMISSION>>');

      delete process.env.ROOT;
    });
  });

  describe('Forfeit Tool', () => {
    it('should output forfeit marker', () => {
      const forfeit = path.join(toolsDir, 'bin', 'exit_forfeit');
      const result = execSync(forfeit).toString();

      expect(result).toContain('###SWE-AGENT-EXIT-FORFEIT###');
    });
  });

  describe('Windowed Editor Tools', () => {
    let testFile: string;

    beforeAll(() => {
      testFile = path.join(tmpDir, 'windowed-test.txt');
      const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
      fs.writeFileSync(testFile, content);
    });

    it('should create new file', () => {
      const create = path.join(toolsDir, 'bin', 'create');
      const newFile = path.join(tmpDir, 'new-file.txt');

      process.env.SWE_AGENT_ENV_FILE = path.join(tmpDir, 'windowed-env.json');

      execSync(`${create} ${newFile}`);

      expect(fs.existsSync(newFile)).toBe(true);

      delete process.env.SWE_AGENT_ENV_FILE;
    });

    it('should open and display file', () => {
      const open = path.join(toolsDir, 'bin', 'open');

      process.env.SWE_AGENT_ENV_FILE = path.join(tmpDir, 'windowed-env2.json');

      const result = execSync(`${open} ${testFile}`).toString();

      expect(result).toContain('Opened');
      expect(result).toContain('line 1');

      delete process.env.SWE_AGENT_ENV_FILE;
    });

    it('should navigate with goto', () => {
      const goto = path.join(toolsDir, 'bin', 'goto');

      process.env.SWE_AGENT_ENV_FILE = path.join(tmpDir, 'windowed-env3.json');

      // First open the file
      const open = path.join(toolsDir, 'bin', 'open');
      execSync(`${open} ${testFile}`);

      // Then goto line 25
      const result = execSync(`${goto} 25`).toString();

      expect(result).toContain('line 25');

      delete process.env.SWE_AGENT_ENV_FILE;
    });
  });

  describe('Diff State Tool', () => {
    it('should update diff state', () => {
      const diffState = path.join(toolsDir, 'bin', '_state_diff_state');

      // Set up git repo
      process.env.ROOT = tmpDir;
      const gitDir = path.join(tmpDir, 'git-test');
      fs.mkdirSync(gitDir, { recursive: true });

      execSync('git init', { cwd: gitDir });
      execSync('git config user.email "test@example.com"', { cwd: gitDir });
      execSync('git config user.name "Test User"', { cwd: gitDir });

      // Create a file
      fs.writeFileSync(path.join(gitDir, 'test.txt'), 'content');

      process.env.ROOT = gitDir;

      // This should not throw
      expect(() => execSync(diffState)).not.toThrow();

      delete process.env.ROOT;
    });
  });

  describe('String Replace Editor', () => {
    let testFile: string;

    beforeAll(() => {
      testFile = path.join(tmpDir, 'edit-test.py');
      fs.writeFileSync(testFile, 'def hello():\n    print("world")\n    return 42');
    });

    it('should view file', () => {
      const editor = path.join(toolsDir, 'bin', 'str_replace_editor');
      const result = execSync(`${editor} view ${testFile}`).toString();

      expect(result).toContain('def hello():');
      expect(result).toContain('print("world")');
    });

    it('should create new file', () => {
      const editor = path.join(toolsDir, 'bin', 'str_replace_editor');
      const newFile = path.join(tmpDir, 'new-edit-file.py');

      execSync(`${editor} create ${newFile} --file-text "# New file\\nprint('created')"`);

      expect(fs.existsSync(newFile)).toBe(true);
      const content = fs.readFileSync(newFile, 'utf-8');
      expect(content).toContain('# New file');
      expect(content).toContain("print('created')");
    });
  });
});

describe('Tool Executability', () => {
  const toolsDir = path.join(__dirname, '..', 'tools', 'bin');

  it('should have all tools as executable scripts', () => {
    const expectedTools = [
      'registry',
      '_read_env',
      '_write_env',
      '_state_diff_state',
      'str_replace_editor',
      'view_image',
      'search_file',
      'search_dir',
      'find_file',
      'submit',
      'exit_forfeit',
      'filemap',
      'open',
      'goto',
      'scroll_up',
      'scroll_down',
      'create',
      'edit',
    ];

    expectedTools.forEach((tool) => {
      const toolPath = path.join(toolsDir, tool);
      expect(fs.existsSync(toolPath)).toBe(true);

      // Check if file is executable (on Unix-like systems)
      if (process.platform !== 'win32') {
        const stats = fs.statSync(toolPath);
        // Check if owner can execute (0o100)
        expect(stats.mode & 0o100).toBeTruthy();
      }
    });
  });

  it('should have proper shebang in all tools', () => {
    const tools = fs.readdirSync(toolsDir);

    tools.forEach((tool) => {
      // Skip setup.sh as it's a bash script
      if (tool === 'setup.sh') {
        return;
      }

      const toolPath = path.join(toolsDir, tool);
      if (fs.statSync(toolPath).isFile()) {
        const content = fs.readFileSync(toolPath, 'utf-8');
        expect(content).toMatch(/^#!\/usr\/bin\/env node/);
      }
    });
  });
});
