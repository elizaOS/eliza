#!/bin/bash

# ElizaOS Documentation Consistency Checker
# This script checks if documentation is accurate and up-to-date with the codebase

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Configuration
DOCS_DIR="packages/docs/docs"
RESULTS_DIR="analysis-results"
TIMESTAMP=$(date -u '+%Y-%m-%d_%H-%M-%S')
REPORT_FILE="${RESULTS_DIR}/docs-consistency-report-${TIMESTAMP}.md"

# Function to print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_section() {
    echo -e "${MAGENTA}[CHECKING]${NC} $1"
}

# Create results directory
mkdir -p "${RESULTS_DIR}"

# Initialize report
cat > "${REPORT_FILE}" << EOF
# ElizaOS Documentation Consistency Report
Generated on: $(date -u '+%Y-%m-%d %H:%M:%S UTC')

This report checks if documentation accurately reflects the current codebase.

---

EOF

print_info "Starting ElizaOS Documentation Consistency Check"
print_info "Results will be saved to: ${REPORT_FILE}"
echo ""

# Function to check if a code entity is documented
check_entity_documented() {
    local entity=$1
    local entity_type=$2

    if ! grep -r "$entity" "$DOCS_DIR" --include="*.md" >/dev/null 2>&1; then
        echo "- $entity_type '$entity' is not documented anywhere"
    fi
}

# Step 1: Check Core Classes/Interfaces Documentation
print_section "Core Classes and Interfaces Documentation"
{
    echo "## Core Classes and Interfaces Documentation"
    echo ""
    echo "### Checking if core types from types.ts are documented..."

    # Extract major interfaces and types from core/src/types.ts
    if [ -f "packages/core/src/types.ts" ]; then
        # Extract interface and type names
        grep -E "^export (interface|type) \w+" "packages/core/src/types.ts" | \
        sed -E 's/export (interface|type) (\w+).*/\2/' | \
        while read -r type_name; do
            check_entity_documented "$type_name" "Type/Interface"
        done | sort -u | head -20
    else
        echo "Could not find packages/core/src/types.ts"
    fi

    echo ""
    echo "### Checking if core services are documented..."
    # Check if services mentioned in code are documented
    find packages -name "*.ts" -path "*/services/*" -type f | while read -r service_file; do
        service_name=$(basename "$service_file" .ts)
        if [[ ! "$service_name" =~ test|spec|index ]]; then
            check_entity_documented "$service_name" "Service"
        fi
    done | sort -u | head -20
} >> "${REPORT_FILE}"

# Step 2: Check Plugin Documentation
print_section "Plugin Documentation"
{
    echo -e "\n---\n"
    echo "## Plugin Documentation"
    echo ""
    echo "### Checking if all plugins have documentation..."

    for plugin_dir in packages/plugin-*; do
        if [ -d "$plugin_dir" ]; then
            plugin_name=$(basename "$plugin_dir")
            if ! grep -r "$plugin_name" "$DOCS_DIR" --include="*.md" >/dev/null 2>&1; then
                echo "- Plugin '$plugin_name' has no documentation"

                # Check if plugin has a README
                if [ -f "$plugin_dir/README.md" ]; then
                    echo "  (Has README.md but not in main docs)"
                fi
            fi
        fi
    done
} >> "${REPORT_FILE}"

# Step 3: Check for Outdated Import Examples
print_section "Outdated Code Examples"
{
    echo -e "\n---\n"
    echo "## Outdated Code Examples in Documentation"
    echo ""

    echo "### Checking for outdated package names..."
    # Check for old package names
    grep -r "@ai16z/" "$DOCS_DIR" --include="*.md" 2>/dev/null | while read -r line; do
        file=$(echo "$line" | cut -d: -f1)
        echo "- $file: Contains old package name @ai16z/ (should be @elizaos/)"
    done | head -10

    echo ""
    echo "### Checking for incorrect import paths..."
    # Check for imports from packages/core instead of @elizaos/core
    grep -r "from ['\"]packages/core" "$DOCS_DIR" --include="*.md" 2>/dev/null | while read -r line; do
        file=$(echo "$line" | cut -d: -f1)
        echo "- $file: Imports from packages/core (should be @elizaos/core)"
    done | head -10

    echo ""
    echo "### Checking for non-bun commands..."
    # Check for npm/yarn/pnpm commands in docs
    grep -rE "(npm install|npm run|yarn|pnpm|npx)" "$DOCS_DIR" --include="*.md" 2>/dev/null | \
    grep -v "bun" | while read -r line; do
        file=$(echo "$line" | cut -d: -f1)
        command=$(echo "$line" | grep -oE "(npm|yarn|pnpm|npx)[^\"'\`]*")
        echo "- $file: Uses '$command' (should use bun)"
    done | head -15
} >> "${REPORT_FILE}"

# Step 4: Check for Broken Internal Links
print_section "Broken Internal Links"
{
    echo -e "\n---\n"
    echo "## Broken Internal Links"
    echo ""

    # Find all markdown links
    grep -r "\[.*\]([^)]*)" "$DOCS_DIR" --include="*.md" 2>/dev/null | while read -r line; do
        file=$(echo "$line" | cut -d: -f1)
        # Extract all links from the line
        echo "$line" | grep -oE '\[[^]]+\]\([^)]+\)' | while read -r link_match; do
            link=$(echo "$link_match" | sed -E 's/\[[^]]+\]\(([^)]+)\)/\1/')

            # Skip external links
            if [[ ! "$link" =~ ^https?:// ]] && [[ ! "$link" =~ ^mailto: ]]; then
                # Handle relative links
                if [[ "$link" =~ ^\.\.?/ ]]; then
                    target_path=$(cd "$(dirname "$file")" && realpath -m "$link" 2>/dev/null || echo "")
                    if [ -n "$target_path" ] && [ ! -f "$target_path" ] && [ ! -d "$target_path" ]; then
                        echo "- $file: broken link to '$link'"
                    fi
                elif [[ "$link" =~ ^/ ]]; then
                    # Absolute path from docs root
                    target_path="$DOCS_DIR$link"
                    if [ ! -f "$target_path" ] && [ ! -d "$target_path" ]; then
                        echo "- $file: broken link to '$link'"
                    fi
                elif [[ "$link" =~ ^# ]]; then
                    # Anchor link - skip for now
                    :
                else
                    # Relative to current directory
                    target_path="$(dirname "$file")/$link"
                    if [ ! -f "$target_path" ] && [ ! -d "$target_path" ]; then
                        echo "- $file: broken link to '$link'"
                    fi
                fi
            fi
        done
    done | sort -u | head -20
} >> "${REPORT_FILE}"

# Step 5: Check API Documentation Coverage
print_section "API Documentation Coverage"
{
    echo -e "\n---\n"
    echo "## API Documentation Coverage"
    echo ""

    echo "### Core API Functions"
    # Check if major exported functions are documented
    find packages/core/src -name "*.ts" -not -path "*/test/*" -not -name "*.test.ts" | while read -r file; do
        # Extract exported functions
        grep -E "^export (async )?function \w+|^export const \w+ = (async )?\(" "$file" 2>/dev/null | \
        sed -E 's/export (async )?function (\w+).*/\2/; s/export const (\w+).*/\1/' | \
        while read -r func_name; do
            if [[ ! "$func_name" =~ ^(test|mock|stub) ]]; then
                check_entity_documented "$func_name" "Function"
            fi
        done
    done | sort -u | head -20

    echo ""
    echo "### CLI Commands"
    # Check if CLI commands are documented
    if [ -d "packages/cli/src/commands" ]; then
        find packages/cli/src/commands -name "*.ts" -not -name "*.test.ts" | while read -r cmd_file; do
            cmd_name=$(basename "$cmd_file" .ts)
            if [ ! -f "$DOCS_DIR/cli/$cmd_name.md" ]; then
                echo "- CLI command '$cmd_name' has no documentation page"
            fi
        done
    fi
} >> "${REPORT_FILE}"

# Step 6: Check Documentation Freshness
print_section "Documentation Freshness"
{
    echo -e "\n---\n"
    echo "## Documentation Freshness"
    echo ""

    echo "### Documentation files not updated in >60 days"
    find "$DOCS_DIR" -name "*.md" -mtime +60 -type f 2>/dev/null | while read -r file; do
        last_modified=$(stat -f "%Sm" -t "%Y-%m-%d" "$file" 2>/dev/null || stat -c "%y" "$file" 2>/dev/null | cut -d' ' -f1)
        echo "- $file (last modified: $last_modified)"
    done | head -15

    echo ""
    echo "### Code files modified more recently than their documentation"
    # For each documented feature, check if code was modified more recently
    for doc_file in $(find "$DOCS_DIR" -name "*.md" -type f); do
        doc_topic=$(basename "$doc_file" .md)
        doc_modified=$(stat -f "%m" "$doc_file" 2>/dev/null || stat -c "%Y" "$doc_file" 2>/dev/null)

        # Find related code files
        find packages -name "*${doc_topic}*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*" 2>/dev/null | while read -r code_file; do
            code_modified=$(stat -f "%m" "$code_file" 2>/dev/null || stat -c "%Y" "$code_file" 2>/dev/null)

            if [ -n "$doc_modified" ] && [ -n "$code_modified" ] && [ "$code_modified" -gt "$doc_modified" ]; then
                echo "- $doc_file may be outdated (related code $code_file was modified more recently)"
            fi
        done
    done | head -10
} >> "${REPORT_FILE}"

# Step 7: Check for Missing Critical Documentation
print_section "Missing Critical Documentation"
{
    echo -e "\n---\n"
    echo "## Missing Critical Documentation"
    echo ""

    echo "### Configuration and Environment Variables"
    # Check if all env vars used in code are documented
    grep -r "process\.env\." packages --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | \
    grep -oE "process\.env\.[A-Z_]+" | \
    sed 's/process\.env\.//' | \
    sort -u | while read -r env_var; do
        if ! grep -r "$env_var" "$DOCS_DIR" --include="*.md" >/dev/null 2>&1; then
            echo "- Environment variable '$env_var' is not documented"
        fi
    done | head -15

    echo ""
    echo "### Error Codes and Messages"
    # Check if custom error classes are documented
    grep -r "class.*Error.*extends" packages --include="*.ts" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | \
    sed -E 's/.*class ([A-Za-z]+Error).*/\1/' | \
    sort -u | while read -r error_class; do
        check_entity_documented "$error_class" "Error Class"
    done | head -10
} >> "${REPORT_FILE}"

# Step 8: Generate Summary
print_section "Generating Summary"
{
    echo -e "\n---\n"
    echo "## Summary"
    echo ""

    # Count issues
    undocumented_count=$(grep -c "is not documented" "${REPORT_FILE}" 2>/dev/null || echo 0)
    broken_links_count=$(grep -c "broken link" "${REPORT_FILE}" 2>/dev/null || echo 0)
    outdated_count=$(grep -c "outdated\|old package name\|should be @elizaos" "${REPORT_FILE}" 2>/dev/null || echo 0)
    missing_docs_count=$(grep -c "has no documentation" "${REPORT_FILE}" 2>/dev/null || echo 0)

    echo "### Issue Counts"
    echo "- Undocumented entities: $undocumented_count"
    echo "- Broken internal links: $broken_links_count"
    echo "- Outdated examples: $outdated_count"
    echo "- Missing documentation files: $missing_docs_count"
    echo ""

    echo "### Priority Actions"
    echo "1. Fix all broken internal links"
    echo "2. Update outdated package names (@ai16z/ → @elizaos/)"
    echo "3. Replace npm/yarn/pnpm commands with bun"
    echo "4. Document all exported types and interfaces"
    echo "5. Create documentation for undocumented plugins"
    echo "6. Update stale documentation (>60 days old)"
    echo "7. Document all environment variables"
    echo ""

    echo "### Documentation Standards"
    echo "- All public APIs must be documented"
    echo "- Code examples must use current package names"
    echo "- All commands must use 'bun' not npm/yarn/pnpm"
    echo "- Internal links must be valid"
    echo "- Documentation should be updated with code changes"
} >> "${REPORT_FILE}"

print_success "Documentation consistency check complete!"
print_info "Full report saved to: ${REPORT_FILE}"
echo ""
print_info "Quick summary:"
grep "### Issue Counts" -A 4 "${REPORT_FILE}"
echo ""
print_info "To view specific sections:"
echo "  grep -A10 'Core Classes' ${REPORT_FILE}"
echo "  grep -A10 'Outdated Code Examples' ${REPORT_FILE}"
echo "  grep -A10 'Broken Internal Links' ${REPORT_FILE}"
echo "  grep -A10 'Missing Critical' ${REPORT_FILE}"
