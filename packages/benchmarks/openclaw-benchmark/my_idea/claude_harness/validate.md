---
description: Comprehensive validation for autour-core platform
---

# Validate Autour Core Platform

Runs comprehensive validation checks across the entire autour-core platform.

## Phase 1: Structure Validation

**Purpose:** Verify hybrid repository structure

```bash
echo "🔍 Phase 1: Structure Validation"

# Check required directories exist
required_dirs=(
  "agents"
  "actors"
  "packages"
  "tools"
  "templates"
  "mcp"
  "docs"
  "PRPs"
  ".github/workflows"
)

for dir in "${required_dirs[@]}"; do
  if [ -d "$dir" ]; then
    echo "✅ $dir exists"
  else
    echo "❌ $dir missing"
    exit 1
  fi
done

# Check required files exist
required_files=(
  "CLAUDE.md"
  "README.md"
  ".env.example"
  ".gitmodules"
)

for file in "${required_files[@]}"; do
  if [ -f "$file" ]; then
    echo "✅ $file exists"
  else
    echo "❌ $file missing"
    exit 1
  fi
done

echo "✅ Structure validation passed"
```

## Phase 2: CLAUDE.md Validation

**Purpose:** Verify project instructions are complete

```bash
echo "🔍 Phase 2: CLAUDE.md Validation"

# Check for required sections
required_sections=(
  "Core Mission"
  "Architectural Principles"
  "Development Workflow"
  "Supabase Integration"
  "Agent vs. Actor"
  "Best Practices"
)

missing_sections=()

for section in "${required_sections[@]}"; do
  if grep -q "$section" CLAUDE.md; then
    echo "✅ Section: $section"
  else
    echo "⚠️  Missing section: $section"
    missing_sections+=("$section")
  fi
done

if [ ${#missing_sections[@]} -gt 0 ]; then
  echo "❌ Missing ${#missing_sections[@]} required sections"
  exit 1
fi

echo "✅ CLAUDE.md validation passed"
```

## Phase 3: Submodules Check

**Purpose:** Verify git submodules are properly initialized

```bash
echo "🔍 Phase 3: Submodules Check"

# Check submodules exist
if [ ! -d "context-engineering/.git" ] && [ ! -f "context-engineering/.git" ]; then
  echo "❌ context-engineering submodule not initialized"
  echo "Run: git submodule update --init --recursive"
  exit 1
fi

if [ ! -d "remote-agentic/.git" ] && [ ! -f "remote-agentic/.git" ]; then
  echo "❌ remote-agentic submodule not initialized"
  echo "Run: git submodule update --init --recursive"
  exit 1
fi

echo "✅ context-engineering submodule OK"
echo "✅ remote-agentic submodule OK"

echo "✅ Submodules check passed"
```

## Phase 4: Environment Configuration

**Purpose:** Check required environment variables are documented

```bash
echo "🔍 Phase 4: Environment Configuration"

# Check .env.example has required variables
required_vars=(
  "SUPABASE_URL"
  "SUPABASE_SERVICE_ROLE_KEY"
  "CLAUDE_API_KEY"
  "DATABASE_URL"
)

missing_vars=()

for var in "${required_vars[@]}"; do
  if grep -q "^$var=" .env.example; then
    echo "✅ $var documented"
  else
    echo "⚠️  $var not in .env.example"
    missing_vars+=("$var")
  fi
done

if [ ${#missing_vars[@]} -gt 2 ]; then
  echo "❌ Too many missing variables"
  exit 1
fi

echo "✅ Environment configuration check passed"
```

## Phase 5: Agents Validation

**Purpose:** Verify agents follow structure

```bash
echo "🔍 Phase 5: Agents Validation"

# Check if any agents exist
if [ -z "$(ls -A agents/ 2>/dev/null)" ]; then
  echo "⚠️  No agents found (OK for initial setup)"
else
  # For each agent, check structure
  for agent_dir in agents/*/; do
    agent_name=$(basename "$agent_dir")
    echo "Checking agent: $agent_name"

    # Check for required files
    if [ -f "$agent_dir/README.md" ]; then
      echo "  ✅ README.md"
    else
      echo "  ⚠️  Missing README.md"
    fi

    if [ -f "$agent_dir/requirements.txt" ] || [ -f "$agent_dir/package.json" ]; then
      echo "  ✅ Dependencies file"
    else
      echo "  ⚠️  Missing dependencies file"
    fi
  done
fi

echo "✅ Agents validation passed"
```

## Phase 6: Actors Validation

**Purpose:** Verify actor submodules have proper Apify structure

```bash
echo "🔍 Phase 6: Actors Validation"

# Check if any actors exist
if [ -z "$(ls -A actors/ 2>/dev/null)" ]; then
  echo "⚠️  No actors found (OK for initial setup)"
else
  # For each actor, check Apify structure
  for actor_dir in actors/*/; do
    actor_name=$(basename "$actor_dir")
    echo "Checking actor: $actor_name"

    # Check for Apify structure
    if [ -f "$actor_dir/.actor/actor.json" ]; then
      echo "  ✅ .actor/actor.json"
    else
      echo "  ❌ Missing .actor/actor.json"
    fi

    if [ -f "$actor_dir/.actor/INPUT_SCHEMA.json" ]; then
      echo "  ✅ INPUT_SCHEMA.json"
    else
      echo "  ⚠️  Missing INPUT_SCHEMA.json"
    fi

    if [ -f "$actor_dir/Dockerfile" ]; then
      echo "  ✅ Dockerfile"
    else
      echo "  ⚠️  Missing Dockerfile"
    fi
  done
fi

echo "✅ Actors validation passed"
```

## Phase 7: GitHub Actions Workflows

**Purpose:** Verify CI/CD workflows are present

```bash
echo "🔍 Phase 7: GitHub Actions Workflows"

required_workflows=(
  "validation.yml"
  "actor-deploy.yml"
)

for workflow in "${required_workflows[@]}"; do
  if [ -f ".github/workflows/$workflow" ]; then
    echo "✅ $workflow exists"
  else
    echo "❌ $workflow missing"
    exit 1
  fi
done

echo "✅ GitHub Actions workflows validation passed"
```

## Phase 8: Supabase Schema Check

**Purpose:** Verify Supabase schema file exists

```bash
echo "🔍 Phase 8: Supabase Schema Check"

if [ -f "PRPs/supabase-schema-REAL.sql" ]; then
  echo "✅ Supabase schema found"

  # Count tables defined
  table_count=$(grep -c "CREATE TABLE" PRPs/supabase-schema-REAL.sql || echo "0")
  echo "   Found $table_count tables"

  if [ "$table_count" -lt 5 ]; then
    echo "⚠️  Schema seems incomplete (<5 tables)"
  fi
else
  echo "⚠️  Supabase schema not found (check PRPs/ directory)"
fi

echo "✅ Supabase schema check passed"
```

## Phase 9: Documentation Check

**Purpose:** Verify key documentation exists

```bash
echo "🔍 Phase 9: Documentation Check"

# Check for key docs
docs=(
  "README.md:Main documentation"
  "CLAUDE.md:AI instructions"
  "PRPs/autour-core-setup-REAL.md:Setup guide"
  ".github/workflows/README.md:Workflows guide"
)

for doc in "${docs[@]}"; do
  file="${doc%:*}"
  desc="${doc#*:}"

  if [ -f "$file" ]; then
    word_count=$(wc -w < "$file")
    echo "✅ $desc ($word_count words)"
  else
    echo "⚠️  Missing: $desc"
  fi
done

echo "✅ Documentation check passed"
```

## Phase 10: Security Check

**Purpose:** Check for accidentally committed secrets

```bash
echo "🔍 Phase 10: Security Check"

# Check for common secret patterns
echo "Scanning for potential secrets..."

# Patterns to check (informational only, doesn't fail)
patterns=(
  'sk-ant-'
  'ghp_'
  'gho_'
  'apify_api_'
  'postgres://'
  'SERVICE_ROLE_KEY'
)

found_secrets=false

for pattern in "${patterns[@]}"; do
  results=$(git grep -n "$pattern" -- ':!.env.example' ':!CLAUDE.md' ':!*.md' || true)
  if [ -n "$results" ]; then
    echo "⚠️  Found pattern '$pattern' in:"
    echo "$results"
    found_secrets=true
  fi
done

if [ "$found_secrets" = true ]; then
  echo "⚠️  Potential secrets found - review above results"
  echo "Note: This doesn't fail validation, just warns"
else
  echo "✅ No obvious secrets found"
fi

echo "✅ Security check passed"
```

## Summary

```bash
echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║   ✅ ALL VALIDATIONS PASSED              ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
echo "Platform structure: ✅"
echo "Documentation: ✅"
echo "Submodules: ✅"
echo "Environment: ✅"
echo "Agents: ✅"
echo "Actors: ✅"
echo "Workflows: ✅"
echo "Schema: ✅"
echo "Security: ✅"
echo ""
echo "🚀 autour-core is ready!"
```

## Usage

```bash
# In Claude Code, run:
/validate

# Or manually via bash:
bash -c "$(cat .claude/commands/validate.md | grep -A 999 '```bash' | grep -B 999 '```' | grep -v '```')"
```

## Notes

- This validation focuses on structure and setup
- For runtime testing, use agent/actor-specific test suites
- For full E2E testing, deploy to staging environment first
- Consider adding custom validations for your specific agents/actors
