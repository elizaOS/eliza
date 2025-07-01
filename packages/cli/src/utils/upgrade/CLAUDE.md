# ELIZAOS PLUGIN MIGRATION - CLAUDE CODE INTEGRATED SYSTEM

**ENHANCED MIGRATION SYSTEM FOR AUTOMATED 0.x → 1.x PLUGIN UPGRADES**

## 🚀 SYSTEM OVERVIEW

This is the **MOST COMPREHENSIVE** ElizaOS plugin migration system, designed for Claude Code to automatically upgrade plugins with **100% success rate**.

### Key Features:

- **9-Gate Progressive System** - No skipping allowed
- **Comprehensive Guide Integration** - All migration knowledge embedded
- **Automatic RAG Search** - Access to all migration guides
- **Test-Driven Validation** - 95%+ coverage requirement
- **Zero-Failure Release** - All tests must pass for npm publish

### Migration Guide References Available:

```
migration-guides/
├── migration-guide.md              # Basic migration steps & core changes
├── state-and-providers-guide.md    # State management & provider updates
├── prompt-and-generation-guide.md  # Template & AI generation migration
├── advanced-migration-guide.md     # Services, settings, evaluators
├── testing-guide.md               # Comprehensive testing requirements
└── completion-requirements.md      # Final validation & release prep
```

---

## ⚠️ CRITICAL INSTRUCTIONS FOR CLAUDE CODE

**THIS IS A GATED PROCESS. YOU CANNOT SKIP STEPS.**

### YOUR REFERENCE GUIDES ARE IN: `migration-guides/`

**YOU MUST REFERENCE THESE GUIDES AT EACH STEP**

---

## 📋 EXECUTION PROTOCOL - 9-GATE SYSTEM

```
GATE 0: Branch Creation → GATE 1: Complete Analysis → GATE 2: Setup & Clean
→ GATE 3: Build Validation → GATE 4: TypeScript Validation → GATE 5: Core Migration
→ GATE 6: Test Requirements (95%+) → GATE 7: Final Setup → GATE 8: Release Validation
```

---

## GATE 0: CREATE 1.x BRANCH ✓

### Execute:

```bash
git checkout -b 1.x
```

### Gate Check:

```bash
git branch --show-current
```

**✓ MUST OUTPUT: `1.x`**
❌ **STOP** if not on 1.x branch

---

## GATE 1: COMPLETE PLUGIN ANALYSIS ✓

### Reference:

- **migration-guide.md** Steps 6-7 for action/provider analysis
- **advanced-migration-guide.md** for services/evaluators
- **state-and-providers-guide.md** for state management patterns

### Execute Comprehensive Analysis:

```bash
# Plugin identification
cat package.json | grep -E '"name"|"version"'

# Source file inventory
find src -name "*.ts" -type f | sort

# Deprecated file check
ls -la | grep -E "biome|vitest|\.lock"

# Action analysis
grep -r "composeContext\|generateObject\|ModelClass" src/ || echo "None found"

# Provider analysis
grep -r "ProviderResult\|optional.*state" src/ || echo "None found"

# Service analysis
grep -r "extends.*Service\|singleton" src/ || echo "None found"

# Settings usage
grep -r "import.*settings" src/ || echo "None found"
```

### REQUIRED OUTPUT - COMPLETE THIS ANALYSIS:

```
=== COMPREHENSIVE PLUGIN MIGRATION ANALYSIS ===
Plugin Name: [exact name from package.json]
Current Version: [current version]
Migration Target: 1.x

🗂️ FILE STRUCTURE ANALYSIS:
1. DEPRECATED FILES TO DELETE:
   □ biome.json: [EXISTS/NOT FOUND]
   □ vitest.config.ts: [EXISTS/NOT FOUND]
   □ *.lock files: [list any found or "NONE"]

2. PACKAGE CONFIGURATION:
   □ Current name: [exact package name]
   □ Needs @elizaos-plugins/ prefix: [YES/NO based on migration-guide.md Step 3.1.5]
   □ Current dependencies: [list @elizaos/core version]

🔧 COMPONENT ANALYSIS:
3. ACTIONS (reference migration-guide.md Step 6):
   [For each action file found:]
   □ File: src/actions/[name].ts
     - Purpose/Function: [brief description]
     - Uses composeContext: [YES/NO]
     - Uses generateObject: [YES/NO]
     - Uses ModelClass: [YES/NO]
     - Has JSON templates: [YES/NO]
     - Uses updateRecentMessageState: [YES/NO]
     - State handling pattern: [describe current approach]

4. PROVIDERS (reference migration-guide.md Step 7):
   [For each provider file found:]
   □ File: src/providers/[name].ts
     - Has 'name' property: [YES/NO]
     - Returns ProviderResult: [YES/NO]
     - State parameter handling: [required/optional/missing]
     - Context formatting: [describe approach]

5. EVALUATORS (reference advanced-migration-guide.md):
   [List any evaluator files and their patterns]
   □ Files: [list or "NONE FOUND"]
   □ Patterns identified: [list patterns or "N/A"]

6. SERVICES (reference advanced-migration-guide.md):
   [List any service files and singleton patterns]
   □ Files: [list or "NONE FOUND"]
   □ Singleton patterns: [describe or "N/A"]

7. SETTINGS USAGE (reference advanced-migration-guide.md):
   □ Files importing 'settings': [list files or "NONE FOUND"]
   □ Usage patterns: [describe or "N/A"]

📊 TESTING ANALYSIS:
8. EXISTING TEST STRUCTURE:
   □ Test files found: [list files or "NONE"]
   □ Test framework: [vitest/bun/none detected]
   □ Coverage tools: [list or "NONE"]

🎯 MIGRATION COMPLEXITY ASSESSMENT:
□ Simple (basic actions/providers only): [YES/NO]
□ Moderate (includes services/evaluators): [YES/NO]
□ Complex (advanced patterns/custom state): [YES/NO]

📝 MIGRATION PRIORITY QUEUE:
1. [Highest priority migration tasks based on analysis]
2. [Second priority tasks]
3. [Additional tasks identified]

=== END COMPREHENSIVE ANALYSIS ===
```

❌ **STOP** - Analysis must be 100% complete before proceeding

---

## GATE 2: INITIAL SETUP & CLEANUP ✓

### Reference: **migration-guide.md Steps 1-5** - Follow EXACTLY

### 2.1 Clean Deprecated Files (migration-guide.md Step 2)

```bash
rm -f biome.json vitest.config.ts
rm -f *.lock *.yml.lock
```

### 2.2 Update package.json (migration-guide.md Step 3)

**CRITICAL REFERENCES:**

- Step 3.1.5 for name format corrections
- Step 3.2 for dependency updates
- Step 3.3-3.5 for script configurations
- Step 3.6 for agentConfig section

### 2.3 TypeScript Configuration (migration-guide.md Step 4)

Create **ALL** required config files:

- tsconfig.json (Step 4.2)
- tsconfig.build.json (Step 4.3)
- tsup.config.ts (Step 4.1)

### 2.4 Initial Build Validation (migration-guide.md Step 5)

```bash
rm -rf dist node_modules .turbo
bun install
bun run build
```

### Gate Check Requirements:

- [ ] Build completes successfully
- [ ] dist/ folder exists with expected files
- [ ] No critical dependency errors

❌ **STOP** if build fails - fix issues using migration-guide.md before proceeding

---

## GATE 3: BUILD VALIDATION LOOP ✓

### Continuous Build Validation:

```bash
# Loop until build passes completely
while ! bun run build; do
    echo "🔨 Build failed - analyzing errors..."
    echo "📖 Check migration-guide.md Step 6.1 for import fixes"
    # Fix identified errors
    # Common issues: import paths, type errors, missing dependencies
done
echo "✅ Build validation complete"
```

### Build Success Criteria:

- Zero build errors
- All TypeScript compilation successful
- Output files generated in dist/

---

## GATE 4: TYPESCRIPT VALIDATION LOOP ✓

### Reference: **advanced-migration-guide.md** for advanced type issues

### Continuous TypeScript Validation:

```bash
# Loop until zero TypeScript errors
while ! bunx tsc --noEmit; do
    echo "🔍 TypeScript errors detected"
    echo "📖 Checking appropriate guides:"
    echo "   - State types: state-and-providers-guide.md"
    echo "   - Action types: migration-guide.md Step 6"
    echo "   - Provider types: migration-guide.md Step 7"
    echo "   - Service types: advanced-migration-guide.md"
    # Fix identified type errors
done
echo "✅ TypeScript validation complete"
```

❌ **STOP** - Do not proceed with any TypeScript errors in src/

---

## GATE 5: COMPREHENSIVE CODE MIGRATION ✓

### Migration Process - File by File Approach:

#### 🎯 ACTIONS MIGRATION (migration-guide.md Step 6)

**For EACH action file identified in analysis:**

1. **Import Updates** (Step 6.1):

   ```typescript
   // Update all imports according to migration-guide.md
   import { logger } from '@elizaos/core'; // was: elizaLogger
   import { AgentRuntime } from '@elizaos/core'; // was: IAgentRuntime
   ```

2. **State Handling** (Step 6.2 + state-and-providers-guide.md):

   - Convert to new state management patterns
   - Update state parameter handling

3. **Context Composition** (Step 6.3):

   - Replace composeContext with new patterns
   - Update template processing

4. **Template Migration** (Step 6.4 + prompt-and-generation-guide.md):

   ```xml
   <!-- Convert JSON templates to XML format -->
   <template>
     <content>{{variable}}</content>
   </template>
   ```

5. **Generation Updates** (Step 6.5):

   - Replace generateObject with runtime.useModel
   - Update model interaction patterns

6. **Handler Pattern Updates** (Step 6.7):
   - Implement new handler interfaces
   - Update response generation

**Validation After Each Action File:**

```bash
bun run build  # MUST PASS
bunx tsc --noEmit  # MUST PASS
```

#### 🔌 PROVIDERS MIGRATION (migration-guide.md Step 7)

**For EACH provider file identified in analysis:**

1. **Name Property** (Step 7.3):

   ```typescript
   export const myProvider: Provider = {
     name: 'providerName', // Add if missing
     // ...
   };
   ```

2. **Return Type Updates** (Step 7.3):

   - Ensure returns ProviderResult
   - Update data structure

3. **State Parameter** (Step 7.3 + state-and-providers-guide.md):
   - Make state parameter non-optional
   - Update state handling logic

**Validation After Each Provider File:**

```bash
bun run build  # MUST PASS
bunx tsc --noEmit  # MUST PASS
```

#### 🚀 ADVANCED FEATURES (advanced-migration-guide.md)

**If identified in analysis:**

- **Settings Management**: Follow advanced-migration-guide.md "Settings Management" section
- **Services Migration**: Follow "Services & Clients Migration" section
- **Evaluators**: Follow "Evaluators Migration" section

#### 🔧 SPECIAL CASES:

- **State Issues**: Reference state-and-providers-guide.md
- **Prompt/Generation Issues**: Reference prompt-and-generation-guide.md
- **Complex Patterns**: Reference advanced-migration-guide.md

### Migration Success Criteria:

- All source files migrated
- Build passes after each file
- TypeScript validation passes
- No deprecated patterns remaining

---

## GATE 6: COMPREHENSIVE TESTING (95%+ COVERAGE) ✓

### Reference: **testing-guide.md** - COMPLETE IMPLEMENTATION REQUIRED

### 6.1 Test Infrastructure Setup (testing-guide.md Section 1-2)

```bash
mkdir -p src/__tests__
```

**Create test-utils.ts** - Copy ENTIRE test-utils.ts from testing-guide.md Section 2

- All mock functions required
- Complete runtime mocking
- Proper test setup utilities

### 6.2 Component Testing (testing-guide.md Sections 3-6)

#### Action Tests (Section 3):

- Test validation functions
- Test handler execution
- Test error conditions
- Test state interactions

#### Provider Tests (Section 4):

- Test data retrieval
- Test formatting logic
- Test state dependencies
- Test error handling

#### Evaluator Tests (Section 5):

- Test evaluation logic
- Test memory operations
- Test relationship tracking

#### Service Tests (Section 6):

- Test lifecycle methods
- Test initialization
- Test cleanup procedures

### 6.3 Test Coverage Validation Loop:

```bash
# MANDATORY LOOP - Continue until 95%+ coverage
while true; do
    echo "🧪 Running comprehensive test suite..."
    bun test --coverage

    # Check coverage percentage
    COVERAGE=$(bun test --coverage 2>&1 | grep -o '[0-9]\+\.[0-9]\+%' | tail -1)
    echo "📊 Current coverage: $COVERAGE"

    # If coverage < 95%, add more tests
    if [[ $(echo "$COVERAGE" | sed 's/%//') < 95 ]]; then
        echo "📈 Coverage below 95% - adding more tests..."
        echo "📖 Reference testing-guide.md examples:"
        echo "   - Error cases (Section 8)"
        echo "   - Edge cases (Section 9.4)"
        echo "   - All branches (Section 9.7)"
        # Add additional tests
    else
        echo "✅ Coverage requirement met: $COVERAGE"
        break
    fi
done
```

### 6.4 Test Quality Requirements (testing-guide.md Sections 8-10):

- **Error Cases** (Section 8): Test all failure scenarios
- **Edge Cases** (Section 9.4): Test boundary conditions
- **Integration Tests** (Section 9.6): Test component interactions
- **Performance Tests** (Section 9.8): Test under load

### Common Test Issues & Solutions (testing-guide.md Section 10):

- **Tests fail together**: Add proper cleanup
- **Mocks not called**: Set before calling action
- **Timeouts**: Mock ALL async dependencies
- **Flaky tests**: Improve test isolation

❌ **STOP** - Must achieve 95%+ coverage before proceeding

---

## GATE 7: FINAL SETUP & CONFIGURATION ✓

### Reference: **completion-requirements.md** - Follow EXACTLY

### 7.1 Required Configuration Files:

#### .gitignore (Section 1):

```gitignore
node_modules/
dist/
.turbo/
*.log
.env*
coverage/
```

#### .npmignore (Section 2):

```npmignore
src/
*.config.*
.github/
coverage/
```

#### LICENSE File (Section 3):

**COPY EXACTLY** from completion-requirements.md

#### .prettierrc (Section 7):

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5"
}
```

### 7.2 GitHub Release Workflow (Section 6):

**CRITICAL**: Create `.github/workflows/npm-deploy.yml`
**COPY EXACTLY** from completion-requirements.md Section 6

### 7.3 Package.json Final Validation (Section 4):

Verify ALL required fields:

- name, version, description
- main, types, exports
- scripts (build, test, dev, format)
- dependencies (@elizaos/core ^1.0.0)
- agentConfig section complete

### 7.4 Code Formatting:

```bash
bun run format
```

### 7.5 Documentation Updates:

- Update README.md
- Replace all `pnpm`/`npm` references with `bun`
- Update installation instructions
- Update usage examples

---

## GATE 8: FINAL RELEASE VALIDATION ✓

### Comprehensive Validation Suite:

```bash
echo "🚀 Starting final validation..."

# Clean environment test
rm -rf dist node_modules .turbo
echo "✓ Environment cleaned"

# Fresh installation
bun install
echo "✓ Dependencies installed"

# Build validation
bun run build
echo "✓ Build successful"

# TypeScript validation
bunx tsc --noEmit
echo "✓ TypeScript validation passed"

# Test suite validation
bun test --coverage
echo "✓ Test suite completed"

# File structure validation
ls -la dist/
echo "✓ Distribution files verified"

# Workflow file validation
cat .github/workflows/npm-deploy.yml > /dev/null
echo "✓ Release workflow verified"
```

### Final Success Criteria - ALL MUST PASS:

- [ ] Build: 0 errors
- [ ] TypeScript: 0 errors in src/
- [ ] Tests: 100% passing
- [ ] Coverage: ≥95%
- [ ] Distribution: index.js & index.d.ts exist
- [ ] Workflow: npm-deploy.yml exists
- [ ] Documentation: Updated with bun commands

---

## 🚨 TROUBLESHOOTING - GUIDE REFERENCE SYSTEM

### Build/Setup Issues:

→ **migration-guide.md** Steps 1-5
→ Check TypeScript configuration
→ Verify dependency versions

### Action Migration Issues:

→ **migration-guide.md** Step 6 (comprehensive action guide)
→ **state-and-providers-guide.md** (for state handling)
→ **prompt-and-generation-guide.md** (for templates)

### Provider Migration Issues:

→ **migration-guide.md** Step 7 (provider requirements)
→ **state-and-providers-guide.md** "Providers in v1" section

### Advanced Component Issues:

→ **advanced-migration-guide.md** (services, settings, evaluators)
→ Complex patterns and singleton management

### Testing Issues:

→ **testing-guide.md** Section 10 (troubleshooting)
→ Sections 3-7 for component-specific examples
→ Section 8-9 for advanced testing patterns

### Final Setup Issues:

→ **completion-requirements.md** (release preparation)
→ GitHub workflow configuration
→ Package configuration validation

---

## ❌ ABSOLUTE STOP CONDITIONS

**DO NOT PROCEED IF ANY OF THESE FAIL:**

1. **Build Errors** → Fix using appropriate guides
2. **TypeScript Errors** → Fix using type-specific guides
3. **Test Failures** → Fix using testing-guide.md
4. **Coverage < 95%** → Add tests using guide examples
5. **Gate Checks Fail** → Complete the failed gate
6. **Validation Loops** → Continue until all pass

---

## ✅ MIGRATION SUCCESS CRITERIA

**Migration is COMPLETE when ALL of these succeed:**

```bash
# Branch verification
git branch --show-current          # Shows: 1.x

# Build verification
bun run build                       # 0 errors, creates dist/

# TypeScript verification
bunx tsc --noEmit                  # 0 errors in src/

# Test verification
bun test --coverage                # All pass, ≥95% coverage

# File verification
ls -la dist/                       # Contains index.js & index.d.ts
ls -la .github/workflows/          # Contains npm-deploy.yml

# Package verification
cat package.json | grep '"version": "1.0.0"'  # Confirms version

# Format verification
bun run format                      # No formatting changes needed
```

**ALL COMMANDS MUST SUCCEED WITH ZERO ERRORS**

---

## 🎯 AUTOMATED SUCCESS INDICATORS

When migration is complete, you should see:

```
✅ MIGRATION COMPLETED SUCCESSFULLY

📊 Final Status Report:
   🏗️  Build: ✅ 0 errors
   🔍 TypeScript: ✅ 0 errors
   🧪 Tests: ✅ All passing
   📈 Coverage: ✅ 95%+
   📦 Distribution: ✅ Ready
   🚀 Release: ✅ Workflow configured

🎉 Plugin successfully migrated to ElizaOS 1.x!
```

---

**END OF COMPREHENSIVE MIGRATION SYSTEM**
