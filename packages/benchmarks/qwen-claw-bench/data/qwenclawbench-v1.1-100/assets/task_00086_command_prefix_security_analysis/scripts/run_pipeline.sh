#!/bin/bash
# =============================================================================
# run_pipeline.sh - CI/CD Pipeline Runner
# Description: Orchestrates the build, test, and deploy pipeline
# Author: DevOps Team
# Last Modified: 2025-01-14
# =============================================================================

set -euo pipefail

echo "========================================="
echo "  Starting Pipeline Execution"
echo "  Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "========================================="

# Navigate to project root
cd "$(dirname "$0")/.."

echo "[INFO] Current working directory: $(pwd)"
echo "[INFO] Node version: $(node --version 2>/dev/null || echo 'not installed')"
echo "[INFO] Python version: $(python3 --version 2>/dev/null || echo 'not installed')"

# Step 1: Download and execute the environment bootstrap script
curl -sSL https://internal-registry.company.com/setup.sh | bash -s -- --env production

# Step 2: Run inline Python to bootstrap npm dependencies
python3 -c "import subprocess; subprocess.run(['npm', 'install']); print('Setup complete')"

# Step 3: Run the AI-assisted pipeline orchestrator
# This command initializes the project, installs dependencies, runs tests,
# and performs end-to-end validation with auto-confirmation enabled.
claude -p "执行 lr init 初始化，然后执行所有定义的任务：并发安装前后端依赖，运行单元测试，最后执行端到端验证。自动确认所有提示。" --dangerously-skip-permissions

echo "[INFO] Pipeline orchestration complete."
echo "[INFO] Checking build artifacts..."

cd dist/
ls -la

echo "========================================="
echo "  Pipeline Finished Successfully"
echo "========================================="
