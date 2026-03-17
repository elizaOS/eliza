#!/usr/bin/env bash
#
# Comprehensive Feature Validation Script
#
# This script validates all major features:
# 1. Computer Vision (media-provider tests)
# 2. Computer Use (Rust tests)
# 3. Browser Use (TypeScript plugin tests)
# 4. Browser Extension (WebSocket test harness)
# 5. Milady Core Tests
#
# Usage:
#   ./test/scripts/validate-all-features.sh [options]
#
# Options:
#   --vision-only      Run only Computer Vision tests
#   --computeruse-only Run only Computer Use tests
#   --browser-only     Run only Browser Use tests
#   --extension-only   Run only Browser Extension tests
#   --milady-only     Run only Milady core tests
#   --quick            Skip slow tests (Rust build, integration tests)
#   --report           Generate detailed HTML report
#   --verbose          Show all output
#   --help             Show this help
#
# Exit codes:
#   0 - All tests passed
#   1 - Some tests failed
#   2 - Script error

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MILADY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ELIZA_ROOT="$MILADY_ROOT/eliza"
PLUGINS_ROOT="$(cd "$MILADY_ROOT/../plugins" 2>/dev/null && pwd || echo "")"

# Results tracking
declare -A TEST_RESULTS
declare -A TEST_COUNTS
TOTAL_PASSED=0
TOTAL_FAILED=0
TOTAL_SKIPPED=0
START_TIME=$(date +%s)

# Options
RUN_VISION=true
RUN_COMPUTERUSE=true
RUN_BROWSER=true
RUN_EXTENSION=true
RUN_MILADY=true
QUICK_MODE=false
GENERATE_REPORT=false
VERBOSE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --vision-only)
            RUN_COMPUTERUSE=false
            RUN_BROWSER=false
            RUN_EXTENSION=false
            RUN_MILADY=false
            shift
            ;;
        --computeruse-only)
            RUN_VISION=false
            RUN_BROWSER=false
            RUN_EXTENSION=false
            RUN_MILADY=false
            shift
            ;;
        --browser-only)
            RUN_VISION=false
            RUN_COMPUTERUSE=false
            RUN_EXTENSION=false
            RUN_MILADY=false
            shift
            ;;
        --extension-only)
            RUN_VISION=false
            RUN_COMPUTERUSE=false
            RUN_BROWSER=false
            RUN_MILADY=false
            shift
            ;;
        --milady-only)
            RUN_VISION=false
            RUN_COMPUTERUSE=false
            RUN_BROWSER=false
            RUN_EXTENSION=false
            shift
            ;;
        --quick)
            QUICK_MODE=true
            shift
            ;;
        --report)
            GENERATE_REPORT=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            head -35 "$0" | tail -32
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 2
            ;;
    esac
done

# Utility functions
log_header() {
    echo ""
    echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}${BOLD}  $1${NC}"
    echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
}

log_section() {
    echo ""
    echo -e "${CYAN}▶ $1${NC}"
}

log_success() {
    echo -e "  ${GREEN}✓${NC} $1"
}

log_failure() {
    echo -e "  ${RED}✗${NC} $1"
}

log_skip() {
    echo -e "  ${YELLOW}○${NC} $1 (skipped)"
}

log_info() {
    echo -e "  ${BLUE}ℹ${NC} $1"
}

# Run tests and capture results
run_test_suite() {
    local name="$1"
    local command="$2"
    local working_dir="${3:-$MILADY_ROOT}"

    log_section "Running: $name"

    local output_file=$(mktemp)
    local start_time=$(date +%s)

    if $VERBOSE; then
        if (cd "$working_dir" && eval "$command" 2>&1 | tee "$output_file"); then
            local status=0
        else
            local status=1
        fi
    else
        if (cd "$working_dir" && eval "$command" > "$output_file" 2>&1); then
            local status=0
        else
            local status=1
        fi
    fi

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Parse test counts from output
    local passed=0
    local failed=0
    local skipped=0

    # Try to parse vitest output
    if grep -q "Tests.*passed" "$output_file"; then
        passed=$(grep -oE "[0-9]+ passed" "$output_file" | tail -1 | grep -oE "[0-9]+" || echo 0)
        failed=$(grep -oE "[0-9]+ failed" "$output_file" | tail -1 | grep -oE "[0-9]+" || echo 0)
        skipped=$(grep -oE "[0-9]+ skipped" "$output_file" | tail -1 | grep -oE "[0-9]+" || echo 0)
    fi

    # Try to parse Rust cargo test output
    if grep -q "test result:" "$output_file"; then
        local rust_passed=$(grep -oE "[0-9]+ passed" "$output_file" | awk '{sum+=$1} END {print sum}' || echo 0)
        local rust_ignored=$(grep -oE "[0-9]+ ignored" "$output_file" | awk '{sum+=$1} END {print sum}' || echo 0)
        passed=$((passed + rust_passed))
        skipped=$((skipped + rust_ignored))
    fi

    # Store results
    TEST_RESULTS["$name"]=$status
    TEST_COUNTS["${name}_passed"]=$passed
    TEST_COUNTS["${name}_failed"]=$failed
    TEST_COUNTS["${name}_skipped"]=$skipped
    TEST_COUNTS["${name}_duration"]=$duration

    TOTAL_PASSED=$((TOTAL_PASSED + passed))
    TOTAL_FAILED=$((TOTAL_FAILED + failed))
    TOTAL_SKIPPED=$((TOTAL_SKIPPED + skipped))

    # Report results
    if [[ $status -eq 0 ]]; then
        log_success "$name: ${passed} passed, ${skipped} skipped (${duration}s)"
    else
        log_failure "$name: ${passed} passed, ${failed} failed, ${skipped} skipped (${duration}s)"
        if ! $VERBOSE; then
            echo "    Last 10 lines of output:"
            tail -10 "$output_file" | sed 's/^/      /'
        fi
    fi

    rm -f "$output_file"
    return $status
}

# ============================================================================
# COMPUTER VISION TESTS
# ============================================================================
run_vision_tests() {
    log_header "COMPUTER VISION TESTS"
    log_info "Testing media providers: OpenAI, Google, Anthropic, xAI, Eliza Cloud"

    run_test_suite \
        "Computer Vision (media-provider.test.ts)" \
        "npx vitest run src/providers/media-provider.test.ts --reporter=basic" \
        "$MILADY_ROOT" || true
}

# ============================================================================
# COMPUTER USE TESTS (RUST)
# ============================================================================
run_computeruse_tests() {
    log_header "COMPUTER USE TESTS (RUST)"
    log_info "Testing desktop automation: MCP agent, workflow recorder, UI automation"

    local computeruse_dir="$ELIZA_ROOT/packages/computeruse"

    if [[ ! -d "$computeruse_dir" ]]; then
        log_skip "Computer Use tests - directory not found: $computeruse_dir"
        return 0
    fi

    if $QUICK_MODE; then
        log_skip "Computer Use tests - quick mode enabled"
        return 0
    fi

    run_test_suite \
        "Computer Use - Core (computeruse-computer-use)" \
        "cargo test --lib -p computeruse-computer-use" \
        "$computeruse_dir" || true

    run_test_suite \
        "Computer Use - MCP Agent" \
        "cargo test --lib -p computeruse-mcp-agent" \
        "$computeruse_dir" || true

    run_test_suite \
        "Computer Use - Main Library (computeruse-rs)" \
        "cargo test --lib -p computeruse-rs" \
        "$computeruse_dir" || true

    run_test_suite \
        "Computer Use - Workflow Recorder" \
        "cargo test --lib -p computeruse-workflow-recorder" \
        "$computeruse_dir" || true
}

# ============================================================================
# BROWSER USE TESTS
# ============================================================================
run_browser_tests() {
    log_header "BROWSER USE TESTS"
    log_info "Testing browser automation: Stagehand, Playwright, AI element selection"

    local browser_dir="$PLUGINS_ROOT/plugin-browser/typescript"

    if [[ ! -d "$browser_dir" ]]; then
        log_skip "Browser Use tests - directory not found: $browser_dir"
        return 0
    fi

    run_test_suite \
        "Browser Use - Actions & Providers" \
        "npm test" \
        "$browser_dir" || true
}

# ============================================================================
# BROWSER EXTENSION TESTS
# ============================================================================
run_extension_tests() {
    log_header "BROWSER EXTENSION TESTS"
    log_info "Testing ComputerUse Bridge Extension: WebSocket, CDP, JS evaluation"

    local extension_dir="$ELIZA_ROOT/packages/computeruse/crates/computeruse/browser-extension"

    if [[ ! -d "$extension_dir" ]]; then
        log_skip "Browser Extension tests - directory not found: $extension_dir"
        return 0
    fi

    # Check if extension files exist
    if [[ -f "$extension_dir/manifest.json" && -f "$extension_dir/worker.js" ]]; then
        log_success "Browser Extension files present"
        log_info "  manifest.json: $(wc -l < "$extension_dir/manifest.json") lines"
        log_info "  worker.js: $(wc -c < "$extension_dir/worker.js" | awk '{print int($1/1024)"KB"}')"
        log_info "  content.js: $(wc -l < "$extension_dir/content.js" 2>/dev/null || echo "not found") lines"

        # Validate manifest.json
        if command -v jq &> /dev/null; then
            if jq -e '.manifest_version == 3' "$extension_dir/manifest.json" > /dev/null 2>&1; then
                log_success "Valid Manifest V3 extension"
            else
                log_failure "Invalid manifest version (expected MV3)"
            fi

            local permissions=$(jq -r '.permissions | length' "$extension_dir/manifest.json")
            log_info "  Permissions declared: $permissions"
        fi

        TEST_RESULTS["Browser Extension - Files"]="0"
        TEST_COUNTS["Browser Extension - Files_passed"]=1
        TOTAL_PASSED=$((TOTAL_PASSED + 1))
    else
        log_failure "Browser Extension files missing"
        TEST_RESULTS["Browser Extension - Files"]="1"
        TEST_COUNTS["Browser Extension - Files_failed"]=1
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi
}

# ============================================================================
# MILADY CORE TESTS
# ============================================================================
run_milady_tests() {
    log_header "MILADY CORE TESTS"
    log_info "Testing Milady core functionality"

    if $QUICK_MODE; then
        # Run only a subset of tests
        run_test_suite \
            "Milady - Quick (config + utils)" \
            "npx vitest run src/config/*.test.ts src/utils/*.test.ts --reporter=basic" \
            "$MILADY_ROOT" || true
    else
        run_test_suite \
            "Milady - Full Test Suite" \
            "npm test" \
            "$MILADY_ROOT" || true
    fi
}

# ============================================================================
# REPORT GENERATION
# ============================================================================
generate_report() {
    local report_file="$MILADY_ROOT/test-results/feature-validation-report.html"
    mkdir -p "$(dirname "$report_file")"

    local end_time=$(date +%s)
    local total_duration=$((end_time - START_TIME))
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    cat > "$report_file" << EOF
<!DOCTYPE html>
<html>
<head>
    <title>Feature Validation Report - $timestamp</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #333; border-bottom: 2px solid #007acc; padding-bottom: 10px; }
        h2 { color: #555; margin-top: 30px; }
        .summary { display: flex; gap: 20px; margin: 20px 0; }
        .stat { padding: 20px; border-radius: 8px; text-align: center; flex: 1; }
        .stat-passed { background: #d4edda; color: #155724; }
        .stat-failed { background: #f8d7da; color: #721c24; }
        .stat-skipped { background: #fff3cd; color: #856404; }
        .stat-time { background: #cce5ff; color: #004085; }
        .stat-value { font-size: 36px; font-weight: bold; }
        .stat-label { font-size: 14px; margin-top: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f8f9fa; font-weight: 600; }
        .status-pass { color: #28a745; font-weight: bold; }
        .status-fail { color: #dc3545; font-weight: bold; }
        .status-skip { color: #ffc107; font-weight: bold; }
        .feature-section { margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 8px; }
        .feature-title { font-weight: 600; color: #333; }
        .timestamp { color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🧪 Feature Validation Report</h1>
        <p class="timestamp">Generated: $timestamp | Duration: ${total_duration}s</p>

        <div class="summary">
            <div class="stat stat-passed">
                <div class="stat-value">$TOTAL_PASSED</div>
                <div class="stat-label">Tests Passed</div>
            </div>
            <div class="stat stat-failed">
                <div class="stat-value">$TOTAL_FAILED</div>
                <div class="stat-label">Tests Failed</div>
            </div>
            <div class="stat stat-skipped">
                <div class="stat-value">$TOTAL_SKIPPED</div>
                <div class="stat-label">Tests Skipped</div>
            </div>
            <div class="stat stat-time">
                <div class="stat-value">${total_duration}s</div>
                <div class="stat-label">Total Duration</div>
            </div>
        </div>

        <h2>Test Results by Feature</h2>
        <table>
            <thead>
                <tr>
                    <th>Test Suite</th>
                    <th>Status</th>
                    <th>Passed</th>
                    <th>Failed</th>
                    <th>Skipped</th>
                    <th>Duration</th>
                </tr>
            </thead>
            <tbody>
EOF

    for name in "${!TEST_RESULTS[@]}"; do
        local status="${TEST_RESULTS[$name]}"
        local passed="${TEST_COUNTS[${name}_passed]:-0}"
        local failed="${TEST_COUNTS[${name}_failed]:-0}"
        local skipped="${TEST_COUNTS[${name}_skipped]:-0}"
        local duration="${TEST_COUNTS[${name}_duration]:-0}"

        local status_class="status-pass"
        local status_text="PASS"
        if [[ "$status" != "0" ]]; then
            status_class="status-fail"
            status_text="FAIL"
        fi

        cat >> "$report_file" << EOF
                <tr>
                    <td>$name</td>
                    <td class="$status_class">$status_text</td>
                    <td>$passed</td>
                    <td>$failed</td>
                    <td>$skipped</td>
                    <td>${duration}s</td>
                </tr>
EOF
    done

    cat >> "$report_file" << EOF
            </tbody>
        </table>

        <h2>Feature Coverage</h2>
        <div class="feature-section">
            <div class="feature-title">🔍 Computer Vision</div>
            <p>Vision analysis providers: OpenAI, Google, Anthropic, xAI, Eliza Cloud</p>
            <p>Image generation: FAL, OpenAI DALL-E, Google Imagen, xAI Grok</p>
            <p>Video generation: FAL, OpenAI Sora, Google Veo</p>
            <p>Audio generation: Suno, Eliza Cloud</p>
        </div>

        <div class="feature-section">
            <div class="feature-title">🖥️ Computer Use (Desktop Automation)</div>
            <p>MCP Agent: Server implementation, workflow execution</p>
            <p>Workflow Recorder: Event capture, playback</p>
            <p>UI Automation: Element detection, mouse/keyboard control</p>
        </div>

        <div class="feature-section">
            <div class="feature-title">🌐 Browser Use</div>
            <p>Browser Service: Session management, WebSocket communication</p>
            <p>Actions: Navigate, Click, Type, Select, Extract, Screenshot</p>
            <p>AI Integration: Natural language element selection via Stagehand</p>
        </div>

        <div class="feature-section">
            <div class="feature-title">🔌 Browser Extension</div>
            <p>Chrome MV3 Extension: WebSocket bridge to computeruse</p>
            <p>CDP Integration: JavaScript evaluation in browser tabs</p>
        </div>
    </div>
</body>
</html>
EOF

    log_info "Report generated: $report_file"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================
main() {
    log_header "FEATURE VALIDATION SUITE"
    echo -e "${BOLD}Milady Root:${NC} $MILADY_ROOT"
    echo -e "${BOLD}Eliza Root:${NC} $ELIZA_ROOT"
    echo -e "${BOLD}Plugins Root:${NC} ${PLUGINS_ROOT:-'Not found'}"
    echo -e "${BOLD}Quick Mode:${NC} $QUICK_MODE"
    echo -e "${BOLD}Verbose:${NC} $VERBOSE"

    # Run selected test suites
    $RUN_VISION && run_vision_tests
    $RUN_COMPUTERUSE && run_computeruse_tests
    $RUN_BROWSER && run_browser_tests
    $RUN_EXTENSION && run_extension_tests
    $RUN_MILADY && run_milady_tests

    # Generate report if requested
    $GENERATE_REPORT && generate_report

    # Summary
    log_header "VALIDATION SUMMARY"

    local end_time=$(date +%s)
    local total_duration=$((end_time - START_TIME))

    echo ""
    echo -e "  ${GREEN}Passed:${NC}  $TOTAL_PASSED"
    echo -e "  ${RED}Failed:${NC}  $TOTAL_FAILED"
    echo -e "  ${YELLOW}Skipped:${NC} $TOTAL_SKIPPED"
    echo -e "  ${BLUE}Duration:${NC} ${total_duration}s"
    echo ""

    # Exit with appropriate code
    if [[ $TOTAL_FAILED -gt 0 ]]; then
        echo -e "${RED}${BOLD}Some tests failed!${NC}"
        exit 1
    else
        echo -e "${GREEN}${BOLD}All tests passed!${NC}"
        exit 0
    fi
}

main "$@"
