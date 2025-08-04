#!/usr/bin/env bun

/**
 * ElizaOS CLI Delegation Debug Tool
 *
 * This script helps diagnose issues with ElizaOS CLI local delegation.
 * When you run `elizaos` commands, the CLI should automatically detect
 * and use local installations when available. This tool helps identify
 * why delegation might not be working.
 *
 * Usage:
 *   bun scripts/debug-cli-delegation.ts          # Run debug analysis
 *   bun scripts/debug-cli-delegation.ts --fix    # Attempt to fix common issues
 *   bun scripts/debug-cli-delegation.ts --help   # Show help
 *
 * Common Issues:
 *   1. No local @elizaos/cli installation
 *   2. Environment variables preventing delegation
 *   3. Running in test/CI mode
 *   4. Already running from local CLI
 *
 * @author ElizaOS Team
 * @version 1.0.0
 */

import { existsSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { bunExecInherit, bunExec, type ExecResult } from '../packages/cli/src/utils/bun-exec';

// Define proper types for better type safety
interface PackageJson {
  name?: string;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface Colors {
  reset: string;
  bright: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
}

interface DebugResult {
  hasLocalCli: boolean;
  isRunningFromLocal: boolean;
  problematicEnvVars: string[];
  problematicArgs: string[];
  delegationWouldSucceed: boolean;
}

// Custom error types for better error handling
class DebugToolError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'DebugToolError';
  }
}

class PackageInstallError extends DebugToolError {
  constructor(
    message: string,
    public readonly stderr: string
  ) {
    super(message, 'PACKAGE_INSTALL_ERROR');
  }
}

// Colors for better output
const colors: Colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// Parse command line arguments
const args = process.argv.slice(2);
const shouldFix = args.includes('--fix');
const showHelp = args.includes('--help') || args.includes('-h');

/**
 * Display help information
 */
function displayHelp(): void {
  console.log(`${colors.cyan}ElizaOS CLI Delegation Debug Tool${colors.reset}`);
  console.log(`${colors.bright}Usage:${colors.reset}`);
  console.log(`  bun scripts/debug-cli-delegation.ts          # Run debug analysis`);
  console.log(`  bun scripts/debug-cli-delegation.ts --fix    # Attempt to fix common issues`);
  console.log(`  bun scripts/debug-cli-delegation.ts --help   # Show this help`);
  console.log();
  console.log(`${colors.bright}Description:${colors.reset}`);
  console.log(`  This tool diagnoses why ElizaOS CLI local delegation might not be working.`);
  console.log(`  The CLI should automatically use local installations when available.`);
  process.exit(0);
}

/**
 * Check if the local CLI exists and get its path
 */
function checkLocalCli(): { exists: boolean; path: string } {
  const localCliPath = path.join(
    process.cwd(),
    'node_modules',
    '@elizaos',
    'cli',
    'dist',
    'index.js'
  );

  return {
    exists: existsSync(localCliPath),
    path: localCliPath,
  };
}

/**
 * Check if we're currently running from the local CLI
 */
function isRunningFromLocalCli(localCliPath: string): boolean {
  const currentScriptPath = process.argv[1];
  const expectedLocalCliPath = path.resolve(localCliPath);
  const currentResolvedPath = currentScriptPath ? path.resolve(currentScriptPath) : 'unknown';

  return currentResolvedPath === expectedLocalCliPath;
}

/**
 * Check for environment variables that would skip delegation
 */
function checkProblematicEnvVars(): string[] {
  const envVarsToCheck = [
    'NODE_ENV',
    'ELIZA_TEST_MODE',
    'ELIZA_CLI_TEST_MODE',
    'ELIZA_SKIP_LOCAL_CLI_DELEGATION',
    'ELIZA_DISABLE_LOCAL_CLI_DELEGATION',
    'BUN_TEST',
    'VITEST',
    'JEST_WORKER_ID',
    'npm_lifecycle_event',
    'CI',
    'CONTINUOUS_INTEGRATION',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'JENKINS_URL',
    'TRAVIS',
    'CIRCLECI',
    'BUILDKITE',
    'DRONE',
    'TEAMCITY_VERSION',
    'APPVEYOR',
    'CODEBUILD_BUILD_ID',
    '_ELIZA_CLI_DELEGATION_DEPTH',
  ];

  const problematicEnvVars: string[] = [];

  envVarsToCheck.forEach((envVar) => {
    const value = process.env[envVar];
    if (value !== undefined) {
      console.log(`   ${colors.bright}${envVar}:${colors.reset} ${value}`);

      // Check if this would cause delegation to be skipped
      if (
        (envVar === 'NODE_ENV' && value === 'test') ||
        (envVar === 'ELIZA_TEST_MODE' && (value === 'true' || value === '1')) ||
        (envVar === 'ELIZA_CLI_TEST_MODE' && value === 'true') ||
        (envVar === 'ELIZA_SKIP_LOCAL_CLI_DELEGATION' && value === 'true') ||
        (envVar === 'ELIZA_DISABLE_LOCAL_CLI_DELEGATION' && value === 'true') ||
        (envVar === 'BUN_TEST' && value === 'true') ||
        (envVar === 'VITEST' && value === 'true') ||
        envVar === 'JEST_WORKER_ID' ||
        (envVar === 'npm_lifecycle_event' && value === 'test') ||
        (envVar === 'CI' && value === 'true') ||
        (envVar === 'CONTINUOUS_INTEGRATION' && value === 'true') ||
        (envVar === 'GITHUB_ACTIONS' && value === 'true') ||
        (envVar === 'GITLAB_CI' && value === 'true') ||
        envVar === 'JENKINS_URL' ||
        (envVar === 'TRAVIS' && value === 'true') ||
        (envVar === 'CIRCLECI' && value === 'true') ||
        (envVar === 'BUILDKITE' && value === 'true') ||
        (envVar === 'DRONE' && value === 'true') ||
        envVar === 'TEAMCITY_VERSION' ||
        (envVar === 'APPVEYOR' && value === 'true') ||
        envVar === 'CODEBUILD_BUILD_ID' ||
        (envVar === '_ELIZA_CLI_DELEGATION_DEPTH' && parseInt(value, 10) > 0)
      ) {
        problematicEnvVars.push(envVar);
      }
    }
  });

  return problematicEnvVars;
}

/**
 * Check for problematic process arguments
 */
function checkProblematicArgs(): string[] {
  const cmdArgs = process.argv.slice(2);
  const problematicArgs: string[] = [];

  if (cmdArgs.includes('--test')) problematicArgs.push('--test');
  if (cmdArgs.includes('test')) problematicArgs.push('test');
  if (cmdArgs.length > 0 && cmdArgs[0] === 'update') problematicArgs.push('update command');
  if (cmdArgs.length > 0 && (cmdArgs[0] === '-v' || cmdArgs[0] === '--version'))
    problematicArgs.push('version command');
  if (process.argv[1] && process.argv[1].includes('test'))
    problematicArgs.push('test in script path');

  return problematicArgs;
}

/**
 * Read and analyze package.json
 */
function analyzePackageJson(): void {
  console.log(`\n${colors.blue}📋 Project Type Detection:${colors.reset}`);
  const packageJsonPath = path.join(process.cwd(), 'package.json');

  if (existsSync(packageJsonPath)) {
    try {
      const packageJsonContent = readFileSync(packageJsonPath, 'utf8');
      const packageJson: PackageJson = JSON.parse(packageJsonContent);

      console.log(
        `   ${colors.bright}Package name:${colors.reset} ${packageJson.name || 'unknown'}`
      );
      // Fix: Use packageJson.type instead of packageJson.packageType
      console.log(
        `   ${colors.bright}Package type:${colors.reset} ${packageJson.type || 'not specified'}`
      );
      console.log(
        `   ${colors.bright}Has elizaos dependency:${colors.reset} ${packageJson.dependencies && packageJson.dependencies['@elizaos/core'] ? `${colors.green}✅${colors.reset}` : `${colors.red}❌${colors.reset}`}`
      );
      console.log(
        `   ${colors.bright}Has elizaos dev dependency:${colors.reset} ${packageJson.devDependencies && packageJson.devDependencies['@elizaos/core'] ? `${colors.green}✅${colors.reset}` : `${colors.red}❌${colors.reset}`}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.log(`   ${colors.red}Error reading package.json:${colors.reset} ${errorMessage}`);
    }
  } else {
    console.log(`   ${colors.yellow}No package.json found${colors.reset}`);
  }
}

/**
 * Install @elizaos/cli locally using bun
 */
async function installLocalCli(): Promise<void> {
  console.log(`${colors.yellow}→ Installing @elizaos/cli locally...${colors.reset}`);

  try {
    const result: ExecResult = await bunExecInherit('bun', ['install', '@elizaos/cli'], {
      cwd: process.cwd(),
    });

    if (result.success) {
      console.log(`${colors.green}✅ Successfully installed @elizaos/cli${colors.reset}`);
    } else {
      throw new PackageInstallError(
        `Failed to install @elizaos/cli: exit code ${result.exitCode}`,
        result.stderr
      );
    }
  } catch (error) {
    if (error instanceof PackageInstallError) {
      console.log(`${colors.red}❌ ${error.message}${colors.reset}`);
      if (error.stderr) {
        console.log(`${colors.red}Error details: ${error.stderr}${colors.reset}`);
      }
    } else {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.log(`${colors.red}❌ Failed to install @elizaos/cli: ${errorMessage}${colors.reset}`);
    }
    throw error;
  }
}

/**
 * Perform auto-fix operations
 */
async function performAutoFix(debugResult: DebugResult): Promise<void> {
  console.log(`\n${colors.magenta}🔧 Auto-Fix Mode:${colors.reset}`);

  if (!debugResult.hasLocalCli) {
    try {
      await installLocalCli();
    } catch (error) {
      // Error already logged in installLocalCli
      return;
    }
  }

  if (debugResult.problematicEnvVars.length > 0) {
    console.log(`${colors.yellow}→ Found problematic environment variables${colors.reset}`);
    console.log(
      `${colors.bright}Note:${colors.reset} You'll need to manually unset: ${debugResult.problematicEnvVars.join(', ')}`
    );
  }
}

/**
 * Display recommendations based on debug results
 */
function displayRecommendations(debugResult: DebugResult): void {
  console.log(`\n${colors.blue}💡 Recommendations:${colors.reset}`);

  if (!debugResult.hasLocalCli && !shouldFix) {
    console.log(
      `   ${colors.bright}•${colors.reset} Install @elizaos/cli locally: ${colors.cyan}bun install @elizaos/cli${colors.reset}`
    );
    console.log(
      `   ${colors.bright}•${colors.reset} Or run with auto-fix: ${colors.cyan}bun scripts/debug-cli-delegation.ts --fix${colors.reset}`
    );
  } else if (debugResult.problematicEnvVars.length > 0) {
    console.log(
      `   ${colors.bright}•${colors.reset} Clear these environment variables: ${colors.bright}${debugResult.problematicEnvVars.join(', ')}${colors.reset}`
    );
    console.log(
      `   ${colors.bright}•${colors.reset} Or run: ${colors.cyan}unset ${debugResult.problematicEnvVars.join(' ')}${colors.reset}`
    );
  } else if (debugResult.problematicArgs.length > 0) {
    console.log(
      `   ${colors.bright}•${colors.reset} Remove problematic arguments or run the command differently`
    );
  } else if (!debugResult.isRunningFromLocal && debugResult.hasLocalCli) {
    console.log(
      `   ${colors.bright}•${colors.reset} Delegation should work. Try running with ${colors.cyan}DEBUG=*${colors.reset} to see more details`
    );
    console.log(
      `   ${colors.bright}•${colors.reset} Or check if the local CLI binary is executable`
    );
    console.log(
      `   ${colors.bright}•${colors.reset} Test with: ${colors.cyan}elizaos --help${colors.reset} (should show "Using local @elizaos/cli installation")`
    );
  } else if (debugResult.hasLocalCli) {
    console.log(
      `   ${colors.green}•${colors.reset} Everything looks good! Local CLI delegation should be working.`
    );
  }
}

/**
 * Display quick test suggestion
 */
function displayQuickTest(debugResult: DebugResult): void {
  if (
    debugResult.hasLocalCli &&
    debugResult.problematicEnvVars.length === 0 &&
    debugResult.problematicArgs.length === 0
  ) {
    console.log(`\n${colors.blue}🧪 Quick Test:${colors.reset}`);
    console.log(`   Run: ${colors.cyan}elizaos --help${colors.reset}`);
    console.log(
      `   Expected: Should show "${colors.green}Using local @elizaos/cli installation${colors.reset}" message`
    );
  }
}

/**
 * Main debug function
 */
async function runDebug(): Promise<void> {
  try {
    if (showHelp) {
      displayHelp();
      return;
    }

    console.log(`${colors.cyan}🔍 ElizaOS CLI Delegation Debug Tool${colors.reset}`);
    console.log(`${colors.bright}${'='.repeat(60)}${colors.reset}`);

    // 1. Check current working directory
    console.log(`${colors.blue}📁 Current directory:${colors.reset} ${process.cwd()}`);

    // 2. Check for local CLI
    const localCliCheck = checkLocalCli();
    console.log(
      `${colors.blue}📦 Local CLI exists:${colors.reset} ${localCliCheck.exists ? `${colors.green}✅${colors.reset}` : `${colors.red}❌${colors.reset}`}`
    );
    console.log(`   ${colors.bright}Path:${colors.reset} ${localCliCheck.path}`);

    if (localCliCheck.exists) {
      try {
        const stats = statSync(localCliCheck.path);
        console.log(`   ${colors.bright}Size:${colors.reset} ${stats.size} bytes`);
        console.log(`   ${colors.bright}Modified:${colors.reset} ${stats.mtime}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.log(`   ${colors.red}Error reading file:${colors.reset} ${errorMessage}`);
      }
    }

    // 3. Check if running from local CLI
    const isRunningFromLocal = isRunningFromLocalCli(localCliCheck.path);
    const currentScriptPath = process.argv[1];

    console.log(`${colors.blue}🔄 Current script:${colors.reset} ${currentScriptPath}`);
    console.log(
      `${colors.blue}🔄 Running from local CLI:${colors.reset} ${isRunningFromLocal ? `${colors.green}✅${colors.reset}` : `${colors.red}❌${colors.reset}`}`
    );

    // 4. Check environment variables
    console.log(`\n${colors.blue}🌍 Environment Variables:${colors.reset}`);
    const problematicEnvVars = checkProblematicEnvVars();

    // 5. Check process arguments
    console.log(`\n${colors.blue}⚙️  Process Arguments:${colors.reset}`);
    console.log(`   ${colors.bright}Full argv:${colors.reset} ${JSON.stringify(process.argv)}`);
    const cmdArgs = process.argv.slice(2);
    console.log(`   ${colors.bright}Command args:${colors.reset} ${JSON.stringify(cmdArgs)}`);

    const problematicArgs = checkProblematicArgs();

    // 6. Analyze delegation outcome
    console.log(`\n${colors.blue}🎯 Delegation Analysis:${colors.reset}`);

    const debugResult: DebugResult = {
      hasLocalCli: localCliCheck.exists,
      isRunningFromLocal,
      problematicEnvVars,
      problematicArgs,
      delegationWouldSucceed: false,
    };

    if (!debugResult.hasLocalCli) {
      console.log(`${colors.red}❌ Delegation would FAIL:${colors.reset} No local CLI found`);
    } else if (debugResult.isRunningFromLocal) {
      console.log(
        `${colors.green}✅ Delegation would SKIP:${colors.reset} Already running from local CLI`
      );
    } else if (debugResult.problematicEnvVars.length > 0) {
      console.log(
        `${colors.yellow}❌ Delegation would SKIP:${colors.reset} Test/CI environment detected (${colors.bright}${debugResult.problematicEnvVars.join(', ')}${colors.reset})`
      );
    } else if (debugResult.problematicArgs.length > 0) {
      console.log(
        `${colors.yellow}❌ Delegation would SKIP:${colors.reset} Problematic arguments (${colors.bright}${debugResult.problematicArgs.join(', ')}${colors.reset})`
      );
    } else {
      console.log(`${colors.green}✅ Delegation should SUCCEED${colors.reset}`);
      debugResult.delegationWouldSucceed = true;
    }

    // 7. Analyze package.json
    analyzePackageJson();

    // 8. Auto-fix if requested
    if (shouldFix) {
      await performAutoFix(debugResult);
    }

    // 9. Display recommendations
    displayRecommendations(debugResult);

    // 10. Display quick test
    displayQuickTest(debugResult);

    console.log(`\n${colors.green}🏁 Debug complete!${colors.reset}`);
  } catch (error) {
    if (error instanceof DebugToolError) {
      console.error(`${colors.red}❌ ${error.message}${colors.reset}`);
      process.exit(1);
    } else {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`${colors.red}❌ Unexpected error: ${errorMessage}${colors.reset}`);
      process.exit(1);
    }
  }
}

// Run the debug tool
runDebug().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error(`${colors.red}❌ Fatal error: ${errorMessage}${colors.reset}`);
  process.exit(1);
});
