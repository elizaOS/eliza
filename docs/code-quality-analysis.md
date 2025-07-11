# Code Quality Analysis Tools

This document describes the automated code quality analysis tools available in the ElizaOS repository.

## Overview

ElizaOS uses a comprehensive suite of code quality analysis tools to maintain high standards across the codebase. These tools run automatically daily and can also be run manually on-demand.

## Automated Daily Analysis

### GitHub Actions Workflow

The repository includes a GitHub Actions workflow that runs daily at noon UTC to analyze code quality and create issues for problems found.

**Workflow:** `.github/workflows/daily-code-quality-analysis.yml`

**Schedule:** Daily at 12:00 PM UTC (noon) on the `develop` branch
- 12:00 PM UTC
- 4:00 AM PST / 7:00 AM EST (US)
- 1:00 PM CET (Europe)
- 8:00 PM CST (China)

**Branch:** Runs on `develop` branch by default
- Scheduled runs: Always analyze `develop` branch
- Manual runs: Can specify different branch via workflow dispatch

**Features:**
- Analyzes the `develop` branch (configurable for manual runs)
- Uses Claude Opus 4 (thinking model) for intelligent analysis
- Creates GitHub issues for critical problems
- Avoids duplicate issues
- Generates comprehensive reports

### What Gets Analyzed

1. **Dead Code Detection** (using [Knip](https://knip.dev/))
   - Unused files, exports, and dependencies
   - Orphaned code that's never imported
   - Unused npm scripts and binaries

2. **Code Quality**
   - Console.log statements left in code
   - TODO/FIXME comments
   - Functions longer than 50 lines
   - Complex conditional statements

3. **Security Vulnerabilities**
   - Hardcoded secrets or API keys
   - Usage of eval()
   - Potential SQL injection risks
   - ReDoS vulnerabilities in regex patterns

4. **Test Coverage**
   - Files without corresponding test files
   - Test files with insufficient test cases
   - Missing test coverage for critical functionality

5. **Type Safety**
   - Excessive use of 'any' type
   - Functions without return type annotations
   - Type assertions that could hide errors
   - @ts-ignore usage

6. **Code Documentation**
   - Exported functions without JSDoc comments
   - Complex functions without documentation
   - Missing inline comments for complex logic

7. **Documentation Accuracy** (in docs package)
   - Broken internal links in markdown files
   - Missing documentation for core packages
   - Outdated code examples (old imports/syntax)
   - Missing API documentation for key concepts
   - Documentation files not updated in >90 days

8. **Repository Standards**
   - Usage of npm/yarn/pnpm instead of bun
   - Incorrect imports (packages/core vs @elizaos/core)
   - Class definitions (should use functional programming)
   - **Non-bun test frameworks** - ElizaOS uses `bun:test` exclusively
     - Any usage of jest, vitest, mocha is a violation
     - Imports like `from 'jest'` or `from 'vitest'` should be flagged
     - Test-only syntax like `describe.only`, `it.only` from other frameworks

## Manual Analysis

### Running On-Demand Analysis

For immediate code quality checks, use the manual analysis script:

```bash
# From the repository root
./scripts/analyze-code-quality.sh
```

Or trigger the GitHub workflow manually:
1. Go to Actions → Daily Code Quality Analysis
2. Click "Run workflow"
3. Select branch to analyze (default: develop)
4. Choose whether to create issues

This script performs the same analysis as the GitHub workflow but saves results locally.

**Output:**
- Results are saved to `analysis-results/full-report-{timestamp}.md`
- Console output shows progress and summary
- Each category of issues is clearly separated

### Documentation Consistency Checker

For specialized documentation accuracy checks, use the dedicated script:

```bash
# From the repository root
./scripts/check-docs-consistency.sh
```

This script performs deep analysis of documentation accuracy:
- Checks if all core types/interfaces are documented
- Verifies all plugins have documentation
- Finds outdated code examples and imports
- Detects broken internal links
- Identifies missing API documentation
- Reports stale documentation files
- Checks if environment variables are documented

**Output:**
- Results saved to `analysis-results/docs-consistency-report-{timestamp}.md`
- Focused specifically on documentation vs code consistency
- Provides actionable items for documentation updates

### Viewing Results

```bash
# View full report
cat analysis-results/full-report-*.md

# View specific sections
grep -A20 'Dead Code Analysis' analysis-results/full-report-*.md
grep -A20 'Security Analysis' analysis-results/full-report-*.md
grep -A20 'Test Coverage Analysis' analysis-results/full-report-*.md
grep -A20 'Documentation Accuracy' analysis-results/full-report-*.md

# View documentation consistency report
cat analysis-results/docs-consistency-report-*.md

# View specific documentation issues
grep -A10 'Broken Internal Links' analysis-results/docs-consistency-report-*.md
grep -A10 'Outdated Code Examples' analysis-results/docs-consistency-report-*.md
```

## Knip Configuration

The repository includes a TypeScript configuration file for Knip dead code detection:

**File:** `knip.config.ts`

### Key Configuration Options

```typescript
{
  // Entry points for analysis
  entry: [
    'packages/*/src/index.{ts,js,tsx,jsx}',
    'packages/cli/src/index.ts',
    // ... other entry points
  ],

  // Files to analyze
  project: [
    'packages/**/src/**/*.{ts,tsx,js,jsx}',
    '!packages/**/dist/**',
    '!packages/**/node_modules/**',
  ],

  // Files to ignore
  ignore: [
    '**/*.test.{ts,tsx,js,jsx}',
    '**/*.spec.{ts,tsx,js,jsx}',
    '**/__tests__/**',
  ],

  // Severity of different issue types
  rules: {
    files: 'error',
    dependencies: 'error',
    exports: 'error',
    types: 'error',
  }
}
```

### Running Knip Separately

```bash
# Install Knip
bun add -D knip

# Run analysis
bunx knip

# Run with specific reporter
bunx knip --reporter compact
bunx knip --reporter symbols
bunx knip --reporter json
```

## Interpreting Results

### Priority Levels

Issues are categorized by priority:

- **CRITICAL**: Security vulnerabilities, exposed secrets, broken functionality
- **HIGH**: Missing tests for core functionality, excessive 'any' types, standard violations, broken documentation links
- **MEDIUM**: Dead code, general code quality issues, documentation gaps, outdated docs
- **LOW**: Minor improvements, style issues, documentation formatting

### Common Issues and Fixes

#### Dead Code
```typescript
// Before: Unused export
export const unusedFunction = () => { /* ... */ }

// Fix: Remove if truly unused, or add a comment if intentionally kept
// @keep - Used by external consumers
export const unusedFunction = () => { /* ... */ }
```

#### Type Safety
```typescript
// Before: Using 'any'
const processData = (data: any) => { /* ... */ }

// After: Proper typing
interface DataItem {
  id: string;
  value: number;
}
const processData = (data: DataItem) => { /* ... */ }
```

#### Missing Tests
```typescript
// For file: packages/core/src/utils/helper.ts
// Create: packages/core/src/utils/helper.test.ts

import { describe, it, expect } from 'bun:test'; // MUST use bun:test
import { helperFunction } from './helper';

describe('helperFunction', () => {
  it('should handle basic case', () => {
    expect(helperFunction('input')).toBe('expected');
  });
});

// NEVER use:
// import { describe, it, expect } from 'vitest';
// import { describe, it, expect } from '@jest/globals';
```

#### Documentation Accuracy
```markdown
// Broken link example
[API Reference](../api/missing-file.md) // This link points to non-existent file

// Outdated import example
import { Agent } from '@ai16z/core'; // Should be @elizaos/core

// Missing documentation
// If core packages like plugin-bootstrap have no docs, it will be flagged

// Run the specialized checker for detailed analysis:
./scripts/check-docs-consistency.sh
```

## GitHub Issues

The automated workflow creates issues with:

- **Title**: `[Code Quality] [Category] Brief description`
- **Labels**: `code-quality` plus category-specific labels
- **Body**: Detailed description, affected files, and recommended fixes

### Issue Categories

- `security` - Security vulnerabilities
- `testing` - Missing test coverage
- `technical-debt` - Code quality issues
- `documentation` - Missing docs
- `type-safety` - TypeScript issues

## Best Practices

### 1. Regular Review
- Review the daily analysis reports
- Address critical issues immediately
- Plan sprints to tackle medium/low priority issues

### 2. Pre-commit Checks
```bash
# Run analysis before committing
./scripts/analyze-code-quality.sh

# Fix issues before pushing
bun test
bunx knip
```

### 3. Continuous Improvement
- Add project-specific rules to Knip config
- Customize analysis thresholds
- Create team-specific standards

### 4. Documentation
- Document why code is kept if Knip flags it as dead
- Add JSDoc comments for complex functions
- Keep README files updated

### 5. Test Framework Compliance
- ALWAYS use `import { describe, it, expect } from 'bun:test'`
- NEVER use jest, vitest, mocha, or any other test framework
- Run tests with `bun test` command only
- Report any non-bun test framework usage as HIGH priority

### 6. Documentation Maintenance
- Keep all documentation up to date with code changes
- Fix broken links immediately
- Update code examples when APIs change
- Document all new features and breaking changes
- Review docs older than 90 days for accuracy
- Run `./scripts/check-docs-consistency.sh` regularly
- Ensure all exported APIs have documentation
- Document all environment variables used in code

## Customization

### Adding New Checks

Edit the workflow or script to add custom checks:

```bash
# In analyze-code-quality.sh or workflow
echo "### Custom Check" >> analysis-results/custom.md
grep -r "pattern" packages --include="*.ts" >> analysis-results/custom.md
```

### Adjusting Thresholds

Modify the analysis parameters:

```bash
# Change function length threshold
awk '/function/ {start=NR} /^}/ {if(NR-start>100) ...}'  # Changed from 50 to 100

# Change test count threshold
if [ "$test_count" -lt 5 ]; then  # Changed from 3 to 5
```

### Excluding Files

Add patterns to ignore specific files:

```typescript
// In knip.config.ts
ignore: [
  '**/*.generated.ts',
  '**/legacy/**',
  // Add your patterns
]
```

## Troubleshooting

### Workflow Not Running

1. Check GitHub Actions is enabled for the repository
2. Verify `ANTHROPIC_API_KEY` secret is set
3. Check workflow syntax with `act` locally

### Too Many False Positives

1. Update Knip configuration to ignore legitimate patterns
2. Add inline comments to preserve needed code
3. Adjust analysis thresholds

### Script Permissions

```bash
# If script won't run
chmod +x scripts/analyze-code-quality.sh
```

## Related Documentation

- [ElizaOS Contributing Guide](../CONTRIBUTING.md)
- [Testing Guide](./testing.md)
- [TypeScript Style Guide](./typescript.md)
- [Security Best Practices](./security.md)

## Available Scripts

- `./scripts/analyze-code-quality.sh` - Comprehensive code quality analysis
- `./scripts/check-docs-consistency.sh` - Documentation accuracy checker

## Support

For questions or issues with code quality tools:

1. Check the workflow logs in GitHub Actions
2. Run the manual script with verbose output
3. Open an issue with the `code-quality` label
4. Reach out in the development Discord channel