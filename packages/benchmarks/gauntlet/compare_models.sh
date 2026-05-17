#!/bin/bash
# compare_models.sh - Test multiple LLM models against the Gauntlet
#
# Models selected for comparison:
#   1. gpt-5.2     - Best for coding/agentic (top tier)
#   2. gpt-5-mini  - Fast, cost-efficient (mid tier)
#   3. gpt-5-nano  - Fastest, cheapest (budget tier)
#   4. gpt-4.1     - Baseline (already tested: 86.3/100)

set -e

MODELS=("gpt-5.2" "gpt-5-mini" "gpt-5-nano" "gpt-4.1")

echo "=============================================="
echo "🧪 Solana Gauntlet - Model Comparison"
echo "=============================================="
echo ""
echo "Models: ${MODELS[*]}"
echo ""

# Load API key from parent directory .env
if [ -f "../.env" ]; then
    source ../.env
elif [ -f ".env" ]; then
    source .env
fi

if [ -z "$OPENAI_API_KEY" ]; then
    echo "❌ OPENAI_API_KEY not found in environment"
    exit 1
fi

export OPENAI_API_KEY

mkdir -p output/model_comparison

RESULTS_FILE="output/model_comparison/summary.md"
echo "# Model Comparison Results" > "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"
echo "| Model | Score | Status | Safety | Task Completion |" >> "$RESULTS_FILE"
echo "|-------|-------|--------|--------|-----------------|" >> "$RESULTS_FILE"

for MODEL in "${MODELS[@]}"; do
    echo "----------------------------------------------"
    echo "🤖 Testing: $MODEL"
    echo "----------------------------------------------"
    
    export LLM_MODEL="$MODEL"
    
    LOG_FILE="output/model_comparison/${MODEL}_log.txt"
    
    # Run the benchmark and capture output
    gauntlet run \
        --agent agents/llm_agent.py \
        --scenarios ./scenarios \
        --output ./output/model_comparison \
        --seed 12345 \
        2>&1 | tee "$LOG_FILE"
    
    # Extract score from log
    SCORE=$(grep "Overall Score:" "$LOG_FILE" | head -1 | grep -oE '[0-9]+\.[0-9]+' || echo "N/A")
    STATUS=$(grep "Status:" "$LOG_FILE" | head -1 | grep -oE '(PASSED|FAILED)' || echo "N/A")
    SAFETY=$(grep "Safety:" "$LOG_FILE" | head -1 | grep -oE '[0-9]+\.[0-9]+' || echo "N/A")
    TASK=$(grep "Task Completion:" "$LOG_FILE" | head -1 | grep -oE '[0-9]+\.[0-9]+' || echo "N/A")
    
    # Append to summary
    echo "| $MODEL | $SCORE | $STATUS | $SAFETY% | $TASK% |" >> "$RESULTS_FILE"
    
    echo ""
    echo "✅ $MODEL complete: $SCORE/100"
    echo ""
    
    # Kill surfpool between runs
    pkill -f surfpool 2>/dev/null || true
    sleep 2
done

echo "=============================================="
echo "📊 All tests complete!"
echo "=============================================="
echo ""
cat "$RESULTS_FILE"
echo ""
echo "Full results: $RESULTS_FILE"
