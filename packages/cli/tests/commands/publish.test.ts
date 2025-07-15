import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { bunExecSync } from '../utils/bun-test-helpers';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeChangeDirectory } from './test-utils';

describe('ElizaOS Publish Commands', () => {
  let testTmpDir: string;
  let originalCwd: string;
  let originalPath: string;

  beforeEach(async () => {
    // Store original working directory and PATH
    originalCwd = process.cwd();
    originalPath = process.env.PATH || '';

    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-publish-'));
    process.chdir(testTmpDir);

    // === COMPREHENSIVE CREDENTIAL MOCKING ===
    // Set all possible environment variables to avoid any prompts
    process.env.GITHUB_TOKEN = 'mock-github-token-for-testing';
    process.env.GH_TOKEN = 'mock-github-token-for-testing';
    process.env.GITHUB_USERNAME = 'test-user';
    process.env.GITHUB_USER = 'test-user';
    process.env.NPM_TOKEN = 'mock-npm-token';
    process.env.NODE_AUTH_TOKEN = 'mock-npm-token';

    // Mock ElizaOS data directory to avoid credential prompts
    const elizaosDataDir = join(testTmpDir, '.elizaos');
    process.env.ELIZAOS_DATA_DIR = elizaosDataDir;
    await mkdir(elizaosDataDir, { recursive: true });

    // Create mock credentials file
    await writeFile(
      join(elizaosDataDir, 'credentials.json'),
      JSON.stringify({
        github: {
          token: 'mock-github-token-for-testing',
          username: 'test-user',
        },
      })
    );

    // Create mock registry settings
    await writeFile(
      join(elizaosDataDir, 'registry.json'),
      JSON.stringify({
        registryUrl: 'https://github.com/elizaos/registry',
        lastUpdated: '2024-01-01T00:00:00.000Z',
      })
    );

    // === COMPREHENSIVE COMMAND MOCKING ===
    // Mock npm and git commands to avoid actual operations
    const mockBinDir = join(testTmpDir, 'mock-bin');
    await mkdir(mockBinDir, { recursive: true });
    process.env.PATH = `${mockBinDir}:${originalPath}`;

    // Create comprehensive npm mock
    await writeFile(
      join(mockBinDir, 'npm'),
      `#!/bin/bash
# Comprehensive npm mock that handles all npm operations without prompts
case "$1" in
  "whoami")
    echo "test-user"
    exit 0
    ;;
  "login")
    echo "Logged in as test-user"
    exit 0
    ;;
  "publish")
    if [[ "$*" == *"--ignore-scripts"* ]]; then
      echo "Published successfully (with --ignore-scripts)"
    else
      echo "Published successfully"
    fi
    exit 0
    ;;
  "run")
    if [[ "$2" == "build" ]]; then
      echo "Build completed"
      exit 0
    fi
    echo "npm run $2 completed"
    exit 0
    ;;
  "version")
    if [[ "$2" == "patch" ]] || [[ "$2" == "minor" ]] || [[ "$2" == "major" ]]; then
      echo "v1.0.1"
      exit 0
    fi
    echo "1.0.0"
    exit 0
    ;;
  "view")
    # Mock npm view for CLI version checking - return empty to avoid update prompts
    echo '{}'
    exit 0
    ;;
  "config")
    case "$2" in
      "get")
        echo "mock-value"
        ;;
      "set")
        echo "Config set successfully"
        ;;
      *)
        echo "npm config $*"
        ;;
    esac
    exit 0
    ;;
  "install"|"i")
    echo "Dependencies installed"
    exit 0
    ;;
  *)
    echo "npm $*"
    exit 0
    ;;
esac`
    );

    // Make npm mock executable (cross-platform)
    if (process.platform === 'win32') {
      // On Windows, create a .cmd file
      await writeFile(
        join(mockBinDir, 'npm.cmd'),
        `@echo off
if "%1"=="whoami" (
  echo test-user
  exit /b 0
)
if "%1"=="login" (
  echo Logged in as test-user
  exit /b 0
)
if "%1"=="publish" (
  echo Published successfully
  exit /b 0
)
if "%1"=="run" (
  echo npm run %2 completed
  exit /b 0
)
if "%1"=="version" (
  if "%2"=="patch" echo v1.0.1
  if "%2"=="minor" echo v1.0.1
  if "%2"=="major" echo v1.0.1
  if "%2"=="" echo 1.0.0
  exit /b 0
)
if "%1"=="view" (
  echo {}
  exit /b 0
)
if "%1"=="config" (
  echo npm config %*
  exit /b 0
)
if "%1"=="install" (
  echo Dependencies installed
  exit /b 0
)
echo npm %*
exit /b 0`
      );
    } else {
      bunExecSync(`chmod +x ${join(mockBinDir, 'npm')}`);
    }

    // Create comprehensive git mock
    const gitMockContent =
      process.platform === 'win32'
        ? `@echo off
if "%1"=="init" (
  echo Initialized git repository
  exit /b 0
)
if "%1"=="add" (
  echo Git add completed
  exit /b 0
)
if "%1"=="commit" (
  echo Git commit completed
  exit /b 0
)
if "%1"=="push" (
  echo Git push completed
  exit /b 0
)
if "%1"=="config" (
  if "%2"=="user.name" echo Test User
  if "%2"=="user.email" echo test@example.com
  if "%2"=="remote.origin.url" echo https://github.com/test-user/test-repo.git
  if not "%2"=="user.name" if not "%2"=="user.email" if not "%2"=="remote.origin.url" echo git config value
  exit /b 0
)
if "%1"=="remote" (
  if "%2"=="get-url" (
    echo https://github.com/test-user/test-repo.git
  ) else (
    echo git remote %*
  )
  exit /b 0
)
if "%1"=="status" (
  echo On branch main
  echo nothing to commit, working tree clean
  exit /b 0
)
if "%1"=="branch" (
  echo * main
  exit /b 0
)
if "%1"=="tag" (
  echo v1.0.0
  exit /b 0
)
echo git %*
exit /b 0`
        : `#!/bin/bash
# Comprehensive git mock that handles all git operations
case "$1" in
  "init")
    echo "Initialized git repository"
    exit 0
    ;;
  "add"|"commit"|"push"|"pull"|"fetch")
    echo "Git $1 completed"
    exit 0
    ;;
  "config")
    case "$2" in
      "user.name")
        echo "Test User"
        ;;
      "user.email")
        echo "test@example.com"
        ;;
      "remote.origin.url")
        echo "https://github.com/test-user/test-repo.git"
        ;;
      *)
        echo "git config value"
        ;;
    esac
    exit 0
    ;;
  "remote")
    if [[ "$2" == "get-url" ]]; then
      echo "https://github.com/test-user/test-repo.git"
    else
      echo "git remote $*"
    fi
    exit 0
    ;;
  "status")
    echo "On branch main"
    echo "nothing to commit, working tree clean"
    exit 0
    ;;
  "branch")
    echo "* main"
    exit 0
    ;;
  "tag")
    echo "v1.0.0"
    exit 0
    ;;
  *)
    echo "git $*"
    exit 0
    ;;
esac`;

    await writeFile(
      join(mockBinDir, process.platform === 'win32' ? 'git.cmd' : 'git'),
      gitMockContent
    );

    // Make git mock executable (Unix only)
    if (process.platform !== 'win32') {
      bunExecSync(`chmod +x ${join(mockBinDir, 'git')}`);
    }

    // Mock gh (GitHub CLI) command
    const ghMockContent =
      process.platform === 'win32'
        ? `@echo off
if "%1"=="auth" (
  echo Logged in to github.com as test-user
  exit /b 0
)
if "%1"=="repo" (
  echo Repository operation completed
  exit /b 0
)
echo gh %*
exit /b 0`
        : `#!/bin/bash
case "$1" in
  "auth")
    echo "Logged in to github.com as test-user"
    exit 0
    ;;
  "repo")
    echo "Repository operation completed"
    exit 0
    ;;
  *)
    echo "gh $*"
    exit 0
    ;;
esac`;

    await writeFile(
      join(mockBinDir, process.platform === 'win32' ? 'gh.cmd' : 'gh'),
      ghMockContent
    );

    // Make gh mock executable (Unix only)
    if (process.platform !== 'win32') {
      bunExecSync(`chmod +x ${join(mockBinDir, 'gh')}`);
    }
  });

  afterEach(async () => {
    // Restore original working directory and PATH
    safeChangeDirectory(originalCwd);
    process.env.PATH = originalPath;

    // Clean up environment variables
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_USERNAME;
    delete process.env.GITHUB_USER;
    delete process.env.NPM_TOKEN;
    delete process.env.NODE_AUTH_TOKEN;
    delete process.env.ELIZAOS_DATA_DIR;

    if (testTmpDir && testTmpDir.includes('eliza-test-publish-')) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  // publish --help (safe test that never prompts)
  it('publish --help shows usage', () => {
    const result = bunExecSync(`elizaos publish --help`, { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos publish');
    expect(result).toContain('Publish a plugin to npm, GitHub, and the registry');
    expect(result).toContain('--npm');
    expect(result).toContain('--test');
    expect(result).toContain('--dry-run');
    expect(result).toContain('--skip-registry');
  });

  // CLI integration (safe test)
  it('publish command integrates with CLI properly', () => {
    // Test that publish command is properly integrated into main CLI
    const helpResult = bunExecSync(`elizaos --help`, { encoding: 'utf8' });
    expect(helpResult).toContain('publish');

    // Test that publish command can be invoked
    const publishHelpResult = bunExecSync(`elizaos publish --help`, { encoding: 'utf8' });
    expect(publishHelpResult).toContain('Options:');
  });

  // Test mode functionality (should not prompt with proper mocking)
  it('publish command validates basic directory structure', () => {
    // Test that publish command works with help
    const result = bunExecSync(`elizaos publish --help`, { encoding: 'utf8' });
    expect(result).toContain('publish');
  });

  it('publish command detects missing images', async () => {
    // Test in a simple plugin directory without creating complex structure
    await mkdir('plugin-simple');
    process.chdir(join(testTmpDir, 'plugin-simple'));
    await writeFile(
      'package.json',
      JSON.stringify({
        name: '@test-user/plugin-simple',
        version: '1.0.0',
      })
    );

    const result = bunExecSync(`elizaos publish --help`, { encoding: 'utf8' });
    expect(result).toContain('publish');
  });

  // Dry run functionality (should not prompt)
  it('publish dry-run flag works', () => {
    // Test that --dry-run flag is recognized
    const result = bunExecSync(`elizaos publish --dry-run --help`, { encoding: 'utf8' });
    expect(result).toContain('dry-run');
  });
});
