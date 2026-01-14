#!/bin/bash

# Example script for running SWE-agent on SWE-bench datasets
# This demonstrates various configurations and use cases

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}SWE-bench Benchmarking Examples${NC}"
echo "=========================================="
echo ""

# 1. Quick test run (3 instances)
echo -e "${GREEN}1. Quick Test Run${NC}"
echo "Running on first 3 SWE-bench lite instances..."
echo ""
echo "Command:"
echo "npx sweagent run-batch \\"
echo "    --instances.type swe_bench \\"
echo "    --instances.subset lite \\"
echo "    --instances.split dev \\"
echo "    --instances.slice :3 \\"
echo "    --instances.shuffle \\"
echo "    --agent.model.name gpt-4o \\"
echo "    --agent.model.per_instance_cost_limit 2.00 \\"
echo "    --output_dir ./quick_test"
echo ""
echo "Press Enter to run this example, or Ctrl+C to skip..."
read

npx sweagent run-batch \
    --instances.type swe_bench \
    --instances.subset lite \
    --instances.split dev \
    --instances.slice :3 \
    --instances.shuffle \
    --agent.model.name gpt-4o \
    --agent.model.per_instance_cost_limit 2.00 \
    --output_dir ./quick_test

echo ""
echo -e "${GREEN}2. Parallel Execution Example${NC}"
echo "Running 10 instances with 3 parallel workers..."
echo ""
echo "Command:"
echo "npx sweagent run-batch \\"
echo "    --instances.type swe_bench \\"
echo "    --instances.subset lite \\"
echo "    --instances.split dev \\"
echo "    --instances.slice :10 \\"
echo "    --num_workers 3 \\"
echo "    --agent.model.name gpt-4o \\"
echo "    --output_dir ./parallel_test"
echo ""
echo "Press Enter to run this example, or Ctrl+C to skip..."
read

npx sweagent run-batch \
    --instances.type swe_bench \
    --instances.subset lite \
    --instances.split dev \
    --instances.slice :10 \
    --num_workers 3 \
    --agent.model.name gpt-4o \
    --output_dir ./parallel_test

echo ""
echo -e "${GREEN}3. Multimodal SWE-bench Example${NC}"
echo "Running on multimodal instances with images..."
echo ""
echo "Command:"
echo "npx sweagent run-batch \\"
echo "    --instances.type swe_bench \\"
echo "    --instances.subset multimodal \\"
echo "    --instances.split dev \\"
echo "    --instances.slice :3 \\"
echo "    --config config/default_mm_with_images.yaml \\"
echo "    --agent.model.name claude-3-sonnet-20241022 \\"
echo "    --output_dir ./multimodal_test"
echo ""
echo "Press Enter to run this example, or Ctrl+C to skip..."
read

npx sweagent run-batch \
    --instances.type swe_bench \
    --instances.subset multimodal \
    --instances.split dev \
    --instances.slice :3 \
    --config config/default_mm_with_images.yaml \
    --agent.model.name claude-3-sonnet-20241022 \
    --output_dir ./multimodal_test

echo ""
echo -e "${GREEN}4. Full Evaluation Run${NC}"
echo "Running with automatic SWE-bench evaluation..."
echo ""
echo "Command:"
echo "npx sweagent run-batch \\"
echo "    --instances.type swe_bench \\"
echo "    --instances.subset lite \\"
echo "    --instances.split dev \\"
echo "    --instances.slice :50 \\"
echo "    --instances.evaluate \\"
echo "    --agent.model.name gpt-4o \\"
echo "    --agent.model.per_instance_cost_limit 2.00 \\"
echo "    --num_workers 5 \\"
echo "    --output_dir ./evaluation_run"
echo ""
echo "Press Enter to run this example, or Ctrl+C to skip..."
read

npx sweagent run-batch \
    --instances.type swe_bench \
    --instances.subset lite \
    --instances.split dev \
    --instances.slice :50 \
    --instances.evaluate \
    --agent.model.name gpt-4o \
    --agent.model.per_instance_cost_limit 2.00 \
    --num_workers 5 \
    --output_dir ./evaluation_run

echo ""
echo -e "${BLUE}All examples completed!${NC}"
echo ""
echo "Check the output directories for results:"
echo "  - ./quick_test: Quick test results"
echo "  - ./parallel_test: Parallel execution results"
echo "  - ./multimodal_test: Multimodal results"
echo "  - ./evaluation_run: Full evaluation results"
echo ""
echo "To view trajectories:"
echo "  npx sweagent inspect ./quick_test/trajectories"
echo ""
echo "To merge predictions:"
echo "  npx sweagent merge-preds ./evaluation_run --output preds.json"
