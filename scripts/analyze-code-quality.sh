#!/bin/bash

# ElizaOS Code Quality Analysis Script
# This script performs comprehensive code quality checks similar to the GitHub workflow
# Runs the same analysis as the daily workflow (scheduled at 12:00 PM UTC)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
RESULTS_DIR="analysis-results"
TIMESTAMP=$(date -u '+%Y-%m-%d_%H-%M-%S')
REPORT_FILE="${RESULTS_DIR}/full-report-${TIMESTAMP}.md"

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

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Create results directory
mkdir -p "${RESULTS_DIR}"

print_info "Starting ElizaOS Code Quality Analysis"
print_info "Results will be saved to: ${REPORT_FILE}"
echo ""

# Check for required tools
print_info "Checking required tools..."
if ! command_exists bun; then
    print_error "bun is not installed. Please install bun first."
    exit 1
fi

# Initialize report
cat > "${REPORT_FILE}" << EOF
# ElizaOS Code Quality Analysis Report
Generated on: $(date -u '+%Y-%m-%d %H:%M:%S UTC')

This automated analysis checks for:
- Dead code using [Knip](https://knip.dev/)
- Code quality issues
- Security vulnerabilities
- Missing test coverage
- Type safety violations
- Documentation gaps
- Repository standard violations

---

EOF

# Step 1: Dead Code Analysis with Knip
print_info "Running dead code analysis with Knip..."
{
    echo "## Dead Code Analysis"
    echo ""
    echo "Analyzed using [Knip](https://knip.dev/) - a comprehensive dead code detection tool"
    echo ""

    # Check if Knip is installed
    if ! command_exists knip && ! bunx knip --version >/dev/null 2>&1; then
        print_warning "Knip not found. Installing..."
        bun add -D knip
    fi

    echo "### Knip Analysis Results"
    if [ -f "knip.config.ts" ] || [ -f "knip.json" ]; then
        bunx knip --reporter compact 2>&1 || echo "Knip analysis completed with issues"
    else
        print_warning "No Knip config found. Using default configuration..."
        # Create temporary Knip config
        cat > knip.temp.json << 'KNIPEOF'
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "entry": ["packages/*/src/index.ts", "packages/*/src/index.js"],
  "project": ["packages/**/src/**/*.{ts,tsx,js,jsx}", "!packages/**/dist/**", "!packages/**/node_modules/**"],
  "ignore": ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**", "**/test/**", "**/tests/**"],
  "ignoreExportsUsedInFile": true
}
KNIPEOF
        bunx knip --config knip.temp.json --reporter compact 2>&1 || echo "Knip analysis completed with issues"
        rm -f knip.temp.json
    fi

    echo ""
    echo "### Potentially Orphaned Files"
    find packages -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" | \
        grep -v node_modules | grep -v dist | while read file; do
        filename=$(basename "$file")
        if [[ ! "$filename" =~ \.(test|spec)\. ]]; then
            if ! grep -r "from.*${filename%.*}" packages --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=dist >/dev/null 2>&1; then
                echo "- $file"
            fi
        fi
    done | head -20 || echo "Analysis completed"
} >> "${REPORT_FILE}"

# Step 2: Code Quality Analysis
print_info "Analyzing code quality..."
{
    echo -e "\n---\n"
    echo "## Code Quality Analysis"
    echo ""

    echo "### Console.log Statements Found"
    grep -r "console\.log" packages --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -20 || echo "None found"

    echo ""
    echo "### TODO/FIXME Comments"
    grep -r "TODO\|FIXME" packages --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -20 || echo "None found"

    echo "### Long Functions (>50 lines)"
    find packages -name "*.ts" -o -name "*.tsx" | grep -v node_modules | grep -v dist | while read file; do
        awk '
        BEGIN {
            brace_count = 0
            in_function = 0
            function_start = 0
            function_name = ""
        }
        
        # Function declaration patterns - more specific and comprehensive
        /^(export\s+)?(async\s+)?function\s+\w+\s*\(/ ||
        /^(export\s+)?(async\s+)?const\s+\w+\s*=\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?const\s+\w+\s*:\s*\w*\s*=\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?let\s+\w+\s*=\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?var\s+\w+\s*=\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?\w+\s*\([^)]*\)\s*[:=]\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?\w+\s*[:=]\s*(async\s*)?\([^)]*\)\s*[:=]\s*(async\s*)?\(/ {
            if (!in_function) {
                in_function = 1
                function_start = NR
                function_name = $0
                brace_count = 0
                # Count opening braces on this line
                gsub(/[^{]/, "", $0)
                brace_count += length($0)
            }
            next
        }
        
        # Handle opening braces
        /{/ {
            if (in_function) {
                # Count opening braces on this line
                gsub(/[^{]/, "", $0)
                brace_count += length($0)
            }
        }
        
        # Handle closing braces - works with indented braces
        /}/ {
            if (in_function) {
                # Count closing braces on this line
                gsub(/[^}]/, "", $0)
                brace_count -= length($0)
                
                # If we have balanced braces, function is complete
                if (brace_count <= 0) {
                    function_length = NR - function_start + 1
                    if (function_length > 50) {
                        print FILENAME ":" function_start "-" NR " (" function_length " lines) - " substr(function_name, 1, 60)
                    }
                    in_function = 0
                    function_start = 0
                    function_name = ""
                    brace_count = 0
                }
            }
        }
        ' "$file" 2>/dev/null
    done | head -20 || echo "Analysis completed"

    echo ""
    echo "### Complex Conditions (>3 &&/||)"
    grep -r "if.*&&.*&&.*&&\|if.*||.*||.*||" packages --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -10 || echo "None found"
} >> "${REPORT_FILE}"

# Step 3: Security Analysis
print_info "Analyzing security issues..."
{
    echo -e "\n---\n"
    echo "## Security Analysis"
    echo ""

    echo "### Potential Hardcoded Secrets"
    grep -r -E "(api_key|apiKey|API_KEY|secret|password|token|private_key|privateKey)\s*[:=]\s*[\"'][^\"']+[\"']" packages --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | grep -v -E "(process\.env|import|interface|type|:\s*string|test|spec|example)" | head -20 || echo "None found"

    echo ""
    echo "### Eval() Usage"
    grep -r "eval\s*(" packages --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null || echo "None found"

    echo ""
    echo "### Potential SQL Injection Risks"
    grep -r -E "(query|execute)\s*\(.*\$\{.*\}|query.*\+.*\+" packages --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -10 || echo "None found"

    echo ""
    echo "### Potential ReDoS Vulnerabilities"
    grep -r -E "new RegExp\(|\/.*(\+|\*|\{[0-9]*,\}).*(\+|\*|\{[0-9]*,\}).*\/" packages --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -10 || echo "None found"
} >> "${REPORT_FILE}"

# Step 4: Test Coverage Analysis
print_info "Analyzing test coverage..."
{
    echo -e "\n---\n"
    echo "## Test Coverage Analysis"
    echo ""

    echo "### Files Without Tests"
    find packages -name "*.ts" -o -name "*.tsx" | grep -v -E "(test|spec|\.d\.ts|node_modules|dist)" | while read file; do
        basename="${file%.*}"
        dirname=$(dirname "$file")
        if ! find "$dirname" -name "$(basename "$basename").test.*" -o -name "$(basename "$basename").spec.*" 2>/dev/null | grep -q .; then
            if ! find "$dirname/__tests__" -name "*$(basename "$basename")*" 2>/dev/null | grep -q .; then
                echo "- $file"
            fi
        fi
    done | head -50 || echo "Analysis completed"

    echo ""
    echo "### Test Files With Few Tests"
    find packages -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" | grep -v node_modules | while read file; do
        test_count=$(grep -c -E "(test|it|describe)\s*\(" "$file" 2>/dev/null || echo 0)
        if [ "$test_count" -lt 3 ]; then
            echo "- $file (only $test_count test blocks)"
        fi
    done 2>/dev/null || echo "Analysis completed"
} >> "${REPORT_FILE}"

# Step 5: Type Safety Analysis
print_info "Analyzing type safety..."
{
    echo -e "\n---\n"
    echo "## Type Safety Analysis"
    echo ""

    echo "### Usage of 'any' Type"
    grep -r -E ":\s*any(\s|$|,|\)|\[)" packages --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -30 || echo "None found"

    echo ""
    echo "### Functions Without Return Types"
    grep -r -E "(function|const)\s+\w+\s*\([^)]*\)\s*\{" packages --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | grep -v -E ":\s*\w+|=>" | head -20 || echo "None found"

    echo ""
    echo "### Type Assertions (as keyword)"
    grep -r -E "\s+as\s+\w+" packages --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | grep -v -E "(import|export|const\s+\w+\s+as)" | head -20 || echo "None found"

    echo ""
    echo "### @ts-ignore Usage"
    grep -r "@ts-ignore" packages --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null || echo "None found"
} >> "${REPORT_FILE}"

# Step 6: Documentation Analysis
print_info "Analyzing documentation..."
{
    echo -e "\n---\n"
    echo "## Documentation Analysis"
    echo ""

    echo "### Exported Functions Without Documentation"
    find packages -name "*.ts" -o -name "*.tsx" | grep -v -E "(node_modules|dist|test|spec)" | while read file; do
        awk '/export\s+(async\s+)?function|export\s+const\s+\w+\s*=\s*(async\s*)?\(/ {
            if (prev !~ /\/\*\*/ && prev !~ /\/\//) {
                print FILENAME":"NR" - "substr($0, 1, 60)"..."
            }
        } {prev=$0}' "$file" 2>/dev/null
    done | head -30 || echo "Analysis completed"

    echo ""
    echo "### Complex Functions Without Comments (>20 lines)"
    find packages -name "*.ts" -o -name "*.tsx" | grep -v -E "(node_modules|dist|test|spec)" | while read file; do
        awk '
        BEGIN {
            brace_count = 0
            in_function = 0
            function_start = 0
            function_name = ""
            has_comment = 0
        }
        
        # Function declaration patterns - more specific and comprehensive
        /^(export\s+)?(async\s+)?function\s+\w+\s*\(/ ||
        /^(export\s+)?(async\s+)?const\s+\w+\s*=\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?const\s+\w+\s*:\s*\w*\s*=\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?let\s+\w+\s*=\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?var\s+\w+\s*=\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?\w+\s*\([^)]*\)\s*[:=]\s*(async\s*)?\(/ ||
        /^(export\s+)?(async\s+)?\w+\s*[:=]\s*(async\s*)?\([^)]*\)\s*[:=]\s*(async\s*)?\(/ {
            if (!in_function) {
                in_function = 1
                function_start = NR
                function_name = $0
                brace_count = 0
                has_comment = 0
                # Count opening braces on this line
                gsub(/[^{]/, "", $0)
                brace_count += length($0)
            }
            next
        }
        
        # Check for comments before function
        /\/\*\*|\/\// {
            if (in_function && NR >= function_start - 3 && NR <= function_start) {
                has_comment = 1
            }
        }
        
        # Handle opening braces
        /{/ {
            if (in_function) {
                # Count opening braces on this line
                gsub(/[^{]/, "", $0)
                brace_count += length($0)
            }
        }
        
        # Handle closing braces - works with indented braces
        /}/ {
            if (in_function) {
                # Count closing braces on this line
                gsub(/[^}]/, "", $0)
                brace_count -= length($0)
                
                # If we have balanced braces, function is complete
                if (brace_count <= 0) {
                    function_length = NR - function_start + 1
                    if (function_length > 20 && !has_comment) {
                        print FILENAME ":" function_start " - Function with " function_length " lines and no documentation"
                    }
                    in_function = 0
                    function_start = 0
                    function_name = ""
                    brace_count = 0
                    has_comment = 0
                }
            }
        }
        ' "$file" 2>/dev/null
    done | head -20 || echo "Analysis completed"
} >> "${REPORT_FILE}"

# Step 7: Documentation Accuracy and Completeness
print_info "Analyzing documentation accuracy..."
{
    echo -e "\n---\n"
    echo "## Documentation Accuracy and Completeness"
    echo ""

    # Check if docs directory exists
    if [ -d "docs" ] || [ -d "packages/docs" ]; then
        DOCS_DIR=$([ -d "docs" ] && echo "docs" || echo "packages/docs")

        echo "### Broken Links in Documentation"
        # Find potential broken internal links
        grep -r "\[.*\]([^)]*)" "$DOCS_DIR" --include="*.md" 2>/dev/null | grep -E "\]\(\.\.?\/|#" | while read line; do
            file=$(echo "$line" | cut -d: -f1)
            link=$(echo "$line" | grep -oE '\]\([^)]+\)' | sed 's/\](\(.*\))/\1/')
            # Check if it's a relative path
            if [[ "$link" =~ ^\.\.?/ ]]; then
                target_path=$(dirname "$file")/"$link"
                if [ ! -f "$target_path" ] && [ ! -d "$target_path" ]; then
                    echo "- $file: broken link to '$link'"
                fi
            fi
        done | head -20 || echo "No broken links found"

        echo ""
        echo "### Missing Documentation for Core Features"
        # Check if important packages have corresponding docs
        for package in packages/core packages/cli packages/client packages/plugin-*; do
            if [ -d "$package" ]; then
                package_name=$(basename "$package")
                if ! grep -r "$package_name" "$DOCS_DIR" --include="*.md" >/dev/null 2>&1; then
                    echo "- No documentation found for package: $package_name"
                fi
            fi
        done || echo "Analysis completed"

        echo ""
        echo "### Outdated Code Examples in Documentation"
        # Look for code blocks that might have outdated imports or syntax
        grep -r "import.*from" "$DOCS_DIR" --include="*.md" 2>/dev/null | grep -E "(packages/core|@ai16z/|elizaos@)" | head -10 || echo "No outdated imports found"

        echo ""
        echo "### Missing API Documentation"
        # Check if key APIs are documented
        echo "Checking for documentation of key APIs..."
        key_apis=("AgentRuntime" "Character" "Memory" "Action" "Provider" "Evaluator" "Service")
        for api in "${key_apis[@]}"; do
            if ! grep -r "$api" "$DOCS_DIR" --include="*.md" >/dev/null 2>&1; then
                echo "- Missing documentation for: $api"
            fi
        done || echo "Analysis completed"

        echo ""
        echo "### Documentation Files Without Updates (>90 days)"
        find "$DOCS_DIR" -name "*.md" -mtime +90 2>/dev/null | head -10 || echo "All documentation recently updated"
    else
        echo "No docs directory found in standard locations"
    fi
} >> "${REPORT_FILE}"

# Step 8: Repository Standards Analysis
print_info "Analyzing repository standards..."
{
    echo -e "\n---\n"
    echo "## Repository Standards Analysis"
    echo ""

    echo "### Non-Bun Package Manager Usage"
    grep -r -E "(npm (install|run)|yarn|pnpm|npx)" packages --include="*.json" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.ts" --include="*.tsx" --exclude-dir=node_modules 2>/dev/null | grep -v -E "(bun|comment|example)" | head -20 || echo "None found"

    echo ""
    echo "### Incorrect Core Package Imports"
    grep -r "from ['\"].*packages/core" packages --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -20 || echo "None found"

    echo ""
    echo "### Class Definitions (Should Use Functional)"
    grep -r -E "^class\s+|export\s+class\s+" packages --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | grep -v -E "(Error|Exception)" | head -20 || echo "None found"

    echo ""
    echo "### Non-Bun Test Framework Usage (Should use bun:test)"
    echo "ElizaOS uses 'bun:test' exclusively. Found usage of other test frameworks:"
    grep -r -E "(from ['\"]vitest|from ['\"]jest|from ['\"]mocha|import.*vitest|import.*jest|require\(['\"]jest|require\(['\"]vitest)" packages --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -20 || echo "None found"
    echo ""
    echo "Test syntax that should use bun:test instead:"
    grep -r -E "(describe\.only|it\.only|test\.only|jest\.|vitest\.|expect\.extend)" packages --include="*.ts" --include="*.tsx" --include="*.test.*" --include="*.spec.*" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -20 || echo "None found"
} >> "${REPORT_FILE}"

# Generate summary
print_info "Generating summary..."
{
    echo -e "\n---\n"
    echo "## Summary"
    echo ""
    echo "### Issue Counts"
    echo ""

    # Count issues in each category
    dead_code_count=$(grep -c "^- " "${REPORT_FILE}" 2>/dev/null || echo 0)
    console_count=$(grep -A20 "Console.log Statements" "${REPORT_FILE}" | grep -c ":" 2>/dev/null || echo 0)
    todo_count=$(grep -A20 "TODO/FIXME" "${REPORT_FILE}" | grep -c ":" 2>/dev/null || echo 0)
    security_count=$(grep -A100 "## Security Analysis" "${REPORT_FILE}" | grep -c ":" 2>/dev/null || echo 0)
    any_type_count=$(grep -A30 "Usage of 'any' Type" "${REPORT_FILE}" | grep -c ":" 2>/dev/null || echo 0)
    docs_accuracy_count=$(grep -A100 "## Documentation Accuracy" "${REPORT_FILE}" | grep -c "^- " 2>/dev/null || echo 0)

    echo "- Dead code files: $dead_code_count"
    echo "- Console.log statements: $console_count"
    echo "- TODO/FIXME comments: $todo_count"
    echo "- Security concerns: $security_count"
    echo "- 'any' type usage: $any_type_count"
    echo "- Documentation issues: $docs_accuracy_count"
    echo ""
    echo "### Next Steps"
    echo ""
    echo "1. Review the findings above and prioritize fixes"
    echo "2. Focus on security issues and missing tests first"
    echo "3. Address type safety violations and dead code"
    echo "4. Update documentation for complex functions"
    echo "5. Fix broken links and outdated examples in docs"
    echo "6. Ensure all code follows repository standards"
} >> "${REPORT_FILE}"

print_success "Analysis complete!"
print_info "Full report saved to: ${REPORT_FILE}"
echo ""
print_info "To view the report, run:"
echo "  cat ${REPORT_FILE}"
echo ""
print_info "To view specific sections:"
echo "  grep -A20 'Dead Code Analysis' ${REPORT_FILE}"
echo "  grep -A20 'Security Analysis' ${REPORT_FILE}"
echo "  grep -A20 'Test Coverage Analysis' ${REPORT_FILE}"
echo "  grep -A20 'Documentation Accuracy' ${REPORT_FILE}"
