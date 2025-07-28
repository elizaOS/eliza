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
 *   bun scripts/debug-cli-delegation.js          # Run debug analysis
 *   bun scripts/debug-cli-delegation.js --fix    # Attempt to fix common issues
 *   bun scripts/debug-cli-delegation.js --help   # Show help
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

import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';

// Colors for better output
const colors = {
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

if (showHelp) {
  console.log(`${colors.cyan}ElizaOS CLI Delegation Debug Tool${colors.reset}`);
  console.log(`${colors.bright}Usage:${colors.reset}`);
  console.log(`  bun scripts/debug-cli-delegation.js          # Run debug analysis`);
  console.log(`  bun scripts/debug-cli-delegation.js --fix    # Attempt to fix common issues`);
  console.log(`  bun scripts/debug-cli-delegation.js --help   # Show this help`);
  console.log();
  console.log(`${colors.bright}Description:${colors.reset}`);
  console.log(`  This tool diagnoses why ElizaOS CLI local delegation might not be working.`);
  console.log(`  The CLI should automatically use local installations when available.`);
  process.exit(0);
}

console.log(`${colors.cyan}🔍 ElizaOS CLI Delegation Debug Tool${colors.reset}`);
console.log(`${colors.bright}${'='.repeat(60)}${colors.reset}`);

// 1. Check current working directory
console.log(`${colors.blue}📁 Current directory:${colors.reset} ${process.cwd()}`);

// 2. Check for local CLI
const localCliPath = path.join(
  process.cwd(),
  'node_modules',
  '@elizaos',
  'cli',
  'dist',
  'index.js'
);
const hasLocalCli = existsSync(localCliPath);
console.log(
  `${colors.blue}📦 Local CLI exists:${colors.reset} ${hasLocalCli ? `${colors.green}✅${colors.reset}` : `${colors.red}❌${colors.reset}`}`
);
console.log(`   ${colors.bright}Path:${colors.reset} ${localCliPath}`);

if (hasLocalCli) {
  try {
    const stats = statSync(localCliPath);
    console.log(`   ${colors.bright}Size:${colors.reset} ${stats.size} bytes`);
    console.log(`   ${colors.bright}Modified:${colors.reset} ${stats.mtime}`);
  } catch (e) {
    console.log(`   ${colors.red}Error reading file:${colors.reset} ${e.message}`);
  }
}

// 3. Check if running from local CLI
const currentScriptPath = process.argv[1];
const expectedLocalCliPath = path.resolve(localCliPath);
const currentResolvedPath = currentScriptPath ? path.resolve(currentScriptPath) : 'unknown';
const isRunningFromLocal = currentResolvedPath === expectedLocalCliPath;

console.log(`${colors.blue}🔄 Current script:${colors.reset} ${currentScriptPath}`);
console.log(
  `${colors.blue}🔄 Running from local CLI:${colors.reset} ${isRunningFromLocal ? `${colors.green}✅${colors.reset}` : `${colors.red}❌${colors.reset}`}`
);

// 4. Check environment variables that would skip delegation
console.log(`\n${colors.blue}🌍 Environment Variables:${colors.reset}`);
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

const problematicEnvVars = [];
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

// 5. Check process arguments
console.log(`\n${colors.blue}⚙️  Process Arguments:${colors.reset}`);
console.log(`   ${colors.bright}Full argv:${colors.reset} ${JSON.stringify(process.argv)}`);
const cmdArgs = process.argv.slice(2);
console.log(`   ${colors.bright}Command args:${colors.reset} ${JSON.stringify(cmdArgs)}`);

const problematicArgs = [];
if (cmdArgs.includes('--test')) problematicArgs.push('--test');
if (cmdArgs.includes('test')) problematicArgs.push('test');
if (cmdArgs.length > 0 && cmdArgs[0] === 'update') problematicArgs.push('update command');
if (process.argv[1] && process.argv[1].includes('test'))
  problematicArgs.push('test in script path');

// 6. Check what would happen with delegation
console.log(`\n${colors.blue}🎯 Delegation Analysis:${colors.reset}`);

if (!hasLocalCli) {
  console.log(`${colors.red}❌ Delegation would FAIL:${colors.reset} No local CLI found`);
} else if (isRunningFromLocal) {
  console.log(
    `${colors.green}✅ Delegation would SKIP:${colors.reset} Already running from local CLI`
  );
} else if (problematicEnvVars.length > 0) {
  console.log(
    `${colors.yellow}❌ Delegation would SKIP:${colors.reset} Test/CI environment detected (${colors.bright}${problematicEnvVars.join(', ')}${colors.reset})`
  );
} else if (problematicArgs.length > 0) {
  console.log(
    `${colors.yellow}❌ Delegation would SKIP:${colors.reset} Problematic arguments (${colors.bright}${problematicArgs.join(', ')}${colors.reset})`
  );
} else {
  console.log(`${colors.green}✅ Delegation should SUCCEED${colors.reset}`);
}

// 7. Check project type detection
console.log(`\n${colors.blue}📋 Project Type Detection:${colors.reset}`);
const packageJsonPath = path.join(process.cwd(), 'package.json');
if (existsSync(packageJsonPath)) {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    console.log(`   ${colors.bright}Package name:${colors.reset} ${packageJson.name || 'unknown'}`);
    console.log(
      `   ${colors.bright}Package type:${colors.reset} ${packageJson.packageType || 'not specified'}`
    );
    console.log(
      `   ${colors.bright}Has elizaos dependency:${colors.reset} ${packageJson.dependencies && packageJson.dependencies['@elizaos/core'] ? `${colors.green}✅${colors.reset}` : `${colors.red}❌${colors.reset}`}`
    );
    console.log(
      `   ${colors.bright}Has elizaos dev dependency:${colors.reset} ${packageJson.devDependencies && packageJson.devDependencies['@elizaos/core'] ? `${colors.green}✅${colors.reset}` : `${colors.red}❌${colors.reset}`}`
    );
  } catch (e) {
    console.log(`   ${colors.red}Error reading package.json:${colors.reset} ${e.message}`);
  }
} else {
  console.log(`   ${colors.yellow}No package.json found${colors.reset}`);
}

// 8. Auto-fix functionality
if (shouldFix) {
  console.log(`\n${colors.magenta}🔧 Auto-Fix Mode:${colors.reset}`);

  if (!hasLocalCli) {
    console.log(`${colors.yellow}→ Installing @elizaos/cli locally...${colors.reset}`);
    try {
      const { execSync } = require('child_process');
      execSync('npm install @elizaos/cli', { stdio: 'inherit', cwd: process.cwd() });
      console.log(`${colors.green}✅ Successfully installed @elizaos/cli${colors.reset}`);
    } catch (error) {
      console.log(
        `${colors.red}❌ Failed to install @elizaos/cli: ${error.message}${colors.reset}`
      );
    }
  }

  if (problematicEnvVars.length > 0) {
    console.log(`${colors.yellow}→ Found problematic environment variables${colors.reset}`);
    console.log(
      `${colors.bright}Note:${colors.reset} You'll need to manually unset: ${problematicEnvVars.join(', ')}`
    );
  }
}

// 9. Recommendations
console.log(`\n${colors.blue}💡 Recommendations:${colors.reset}`);
if (!hasLocalCli && !shouldFix) {
  console.log(
    `   ${colors.bright}•${colors.reset} Install @elizaos/cli locally: ${colors.cyan}npm install @elizaos/cli${colors.reset}`
  );
  console.log(
    `   ${colors.bright}•${colors.reset} Or run with auto-fix: ${colors.cyan}bun scripts/debug-cli-delegation.js --fix${colors.reset}`
  );
} else if (problematicEnvVars.length > 0) {
  console.log(
    `   ${colors.bright}•${colors.reset} Clear these environment variables: ${colors.bright}${problematicEnvVars.join(', ')}${colors.reset}`
  );
  console.log(
    `   ${colors.bright}•${colors.reset} Or run: ${colors.cyan}unset ${problematicEnvVars.join(' ')}${colors.reset}`
  );
} else if (problematicArgs.length > 0) {
  console.log(
    `   ${colors.bright}•${colors.reset} Remove problematic arguments or run the command differently`
  );
} else if (!isRunningFromLocal && hasLocalCli) {
  console.log(
    `   ${colors.bright}•${colors.reset} Delegation should work. Try running with ${colors.cyan}DEBUG=*${colors.reset} to see more details`
  );
  console.log(`   ${colors.bright}•${colors.reset} Or check if the local CLI binary is executable`);
  console.log(
    `   ${colors.bright}•${colors.reset} Test with: ${colors.cyan}elizaos --help${colors.reset} (should show "Using local @elizaos/cli installation")`
  );
} else if (hasLocalCli) {
  console.log(
    `   ${colors.green}•${colors.reset} Everything looks good! Local CLI delegation should be working.`
  );
}

// 10. Quick test suggestion
if (hasLocalCli && problematicEnvVars.length === 0 && problematicArgs.length === 0) {
  console.log(`\n${colors.blue}🧪 Quick Test:${colors.reset}`);
  console.log(`   Run: ${colors.cyan}elizaos --help${colors.reset}`);
  console.log(
    `   Expected: Should show "${colors.green}Using local @elizaos/cli installation${colors.reset}" message`
  );
}

console.log(`\n${colors.green}🏁 Debug complete!${colors.reset}`);
