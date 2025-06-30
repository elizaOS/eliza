# ElizaOS Plugin Migration - INTEGRATED EXECUTION PROTOCOL

## ⚠️ CRITICAL INSTRUCTIONS FOR CLAUDE CODE

**THIS IS A GATED PROCESS. YOU CANNOT SKIP STEPS.**

### YOUR REFERENCE GUIDES ARE IN:

```
instruction-for-migration/
  ├── migration-guide.md          # Basic migration steps
  ├── state-and-providers-guide.md # State & provider details
  ├── prompt-and-generation-guide.md # Template & generation migration
  ├── advanced-migration-guide.md  # Services, settings, evaluators
  ├── testing-guide.md               # Complete testing guide
  └── completion-requirements.md       # Final setup requirements
```

**YOU MUST REFERENCE THESE GUIDES AT EACH STEP**

---

## EXECUTION PROTOCOL - GATE SYSTEM

```
GATE 0: Branch → GATE 1: Analysis → GATE 2: Setup → GATE 3: Build
→ GATE 4: TypeScript → GATE 5: Migration → GATE 6: Tests (95%+)
→ GATE 7: Final → GATE 8: Verification
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

## GATE 1: COMPLETE ANALYSIS ✓

### Reference:

- Check all sections from `migration-guide.md` Step 6-7
- Check `advanced-migration-guide.md` for services/evaluators

### Execute Analysis:

```bash
# Identify plugin
cat package.json | grep -E '"name"|"version"'

# List all source files
find src -name "*.ts" -type f | sort

# Check for deprecated files
ls -la | grep -E "biome|vitest|\.lock"
```

### REQUIRED OUTPUT - COMPLETE THIS:

```
=== PLUGIN MIGRATION ANALYSIS ===
Plugin: [name from package.json]
Version: [current version]

1. FILES TO DELETE (check migration-guide.md Step 2):
   □ biome.json: [EXISTS/NOT FOUND]
   □ vitest.config.ts: [EXISTS/NOT FOUND]
   □ *.lock files: [list any found]

2. PACKAGE NAME (check migration-guide.md Step 3.1.5):
   □ Current: [exact name]
   □ Needs fix: [YES if @elizaos-plugins/ / NO]

3. ACTIONS (check migration-guide.md Step 6):
   □ src/actions/[name].ts
     - Purpose: [what it does]
     - Uses composeContext: [YES/NO]
     - Uses generateObject: [YES/NO]
     - Uses ModelClass: [YES/NO]
     - Has JSON templates: [YES/NO]
     - Uses updateRecentMessageState: [YES/NO]

4. PROVIDERS (check migration-guide.md Step 7):
   □ src/providers/[name].ts
     - Has 'name' property: [YES/NO]
     - Returns ProviderResult: [YES/NO]
     - State parameter optional: [YES/NO]

5. EVALUATORS (check advanced-migration-guide.md):
   □ [list any evaluators and issues]

6. SERVICES (check advanced-migration-guide.md):
   □ [list any services with singleton pattern]

7. SETTINGS USAGE (check advanced-migration-guide.md):
   □ Files importing 'settings': [list files]

8. EXISTING TESTS:
   □ Test files: [list or "NONE"]
   □ Framework: [vitest/bun/none]
=== END ANALYSIS ===
```

❌ **STOP** - Analysis must be 100% complete

---

## GATE 2: INITIAL SETUP ✓

### Reference: Follow `migration-guide.md` Steps 1-5 EXACTLY

### 2.1 Clean Files (migration-guide.md Step 2)

```bash
rm -f biome.json vitest.config.ts
rm -f *.lock *.yml.lock
```

### 2.2 Update package.json (migration-guide.md Step 3)

- **CRITICAL**: Check Step 3.1.5 for name fix
- Copy ALL sections from Step 3
- Don't forget `agentConfig` (Step 3.6)

### 2.3 TypeScript Config (migration-guide.md Step 4)

- Create tsconfig.json (Step 4.2)
- Create tsconfig.build.json (Step 4.3)
- Create tsup.config.ts (Step 4.1)

### 2.4 Build Test (migration-guide.md Step 5)

```bash
rm -rf dist node_modules .turbo
bun install
bun run build
```

### Gate Check:

- [ ] Build completes
- [ ] dist/ folder exists

❌ **STOP** if build fails

---

## GATE 3: BUILD MUST PASS ✓

### Loop Until Build Passes:

```bash
while ! bun run build; do
    echo "Build failed. Check errors above."
    # Fix errors using migration-guide.md
    # Common issues are in Step 6.1 (imports)
done
```

---

## GATE 4: TYPESCRIPT MUST PASS ✓

### Reference: Check `advanced-migration-guide.md` for type issues

### Loop Until No Errors:

```bash
while ! bunx tsc --noEmit; do
    echo "TypeScript errors found."
    # Fix using appropriate guide:
    # - State types: state-and-providers-guide.md
    # - Action types: migration-guide.md Step 6
    # - Provider types: migration-guide.md Step 7
done
```

❌ **STOP** - Do not proceed with TypeScript errors

---

## GATE 5: CODE MIGRATION ✓

### For EACH File Identified in Analysis:

#### ACTIONS (Use migration-guide.md Step 6):

1. Update imports (Step 6.1)
2. Fix state handling (Step 6.2)
3. Replace composeContext (Step 6.3)
4. Convert templates to XML (Step 6.4)
5. Replace generateObject (Step 6.5)
6. Update handler pattern (Step 6.7)

**After EACH action file:**

```bash
bun run build  # MUST PASS
```

#### PROVIDERS (Use migration-guide.md Step 7):

1. Add 'name' property (Step 7.3)
2. Update return type (Step 7.3)
3. Make state non-optional (Step 7.3)

**After EACH provider file:**

```bash
bun run build  # MUST PASS
```

#### ADVANCED FEATURES:

- **Settings**: Use advanced-migration-guide.md Section "Settings Management"
- **Services**: Use advanced-migration-guide.md Section "Services & Clients Migration"
- **Evaluators**: Use advanced-migration-guide.md Section "Evaluators Migration"

#### SPECIAL CASES:

- **State Issues**: Check state-and-providers-guide.md
- **Prompt/Generation Issues**: Check prompt-and-generation-guide.md

---

## GATE 6: TESTS MUST REACH 95%+ ✓

### Reference: Use testing-guide.md COMPLETELY

### 6.1 Create Test Structure (testing-guide.md Section 1)

```bash
mkdir -p src/__tests__
```

### 6.2 Create test-utils.ts (testing-guide.md Section 2)

- Copy the ENTIRE test-utils.ts from the guide
- Don't skip any mock functions

### 6.3 Write Tests Following Examples:

- Actions: testing-guide.md Section 3
- Providers: testing-guide.md Section 4
- Evaluators: testing-guide.md Section 5
- Services: testing-guide.md Section 6

### 6.4 Coverage Loop:

```bash
# MUST LOOP UNTIL COVERAGE >= 95%
while true; do
    bun test --coverage
    # Check coverage percentage
    # If < 95%, add more tests using testing-guide.md examples
    # Common missing coverage:
    # - Error cases (Section 8)
    # - Edge cases (Section 9.4)
    # - All branches (Section 9.7)
done
```

### Common Test Issues (testing-guide.md Section 10):

- Tests fail together: Add proper cleanup
- Mocks not called: Set before calling action
- Timeouts: Mock ALL async dependencies

❌ **STOP** - Must have 95%+ coverage

---

## GATE 7: FINAL SETUP ✓

### Reference: Follow completion-requirements.md EXACTLY

### 7.1 Create Required Files:

- .gitignore (Section 1)
- .npmignore (Section 2)
- LICENSE (Section 3) - COPY EXACTLY
- .prettierrc (Section 7) - COPY EXACTLY

### 7.2 GitHub Workflow (Section 6):

**CRITICAL**: Copy `.github/workflows/npm-deploy.yml` EXACTLY from the guide

### 7.3 Verify package.json (Section 4):

- Check ALL fields listed
- Ensure agentConfig is complete

### 7.4 Format Code:

```bash
bun run format
```

### 7.5 Update README:

- Replace all `pnpm`/`npm` with `bun`

---

## GATE 8: FINAL VERIFICATION ✓

### Clean Build Test:

```bash
rm -rf dist node_modules .turbo
bun install
bun run build
bunx tsc --noEmit
bun test --coverage
```

### All Must Pass:

- [ ] Build: 0 errors
- [ ] TypeScript: 0 errors
- [ ] Tests: All pass
- [ ] Coverage: ≥95%

---

## 🚨 WHEN STUCK - GUIDE REFERENCE

### Build/Setup Issues:

→ Check `migration-guide.md` Steps 1-5

### Action Migration Issues:

→ Check `migration-guide.md` Step 6
→ For state: `state-and-providers-guide.md`
→ For templates: `prompt-and-generation-guide.md`

### Provider Issues:

→ Check `migration-guide.md` Step 7
→ For details: `state-and-providers-guide.md` "Providers in v1"

### Service/Settings Issues:

→ Check `advanced-migration-guide.md`

### Test Issues:

→ Check `testing-guide.md` Section 10
→ For examples: Sections 3-7

### Final Setup:

→ Check `completion-requirements.md`

---

## ❌ DO NOT PROCEED IF:

1. **Build has errors** - Fix using guides
2. **TypeScript has errors** - Fix using guides
3. **Tests fail** - Fix using testing-guide.md
4. **Coverage < 95%** - Add tests using examples
5. **Any gate check fails** - Go back and complete

## ✅ MIGRATION COMPLETE WHEN:

```bash
git branch --show-current  # Shows: 1.x
bun run build             # 0 errors
bunx tsc --noEmit        # 0 errors
bun test --coverage      # All pass, ≥95%
ls -la dist/             # Has index.js & index.d.ts
cat .github/workflows/npm-deploy.yml  # Exists
```

**ALL MUST SUCCEED**
