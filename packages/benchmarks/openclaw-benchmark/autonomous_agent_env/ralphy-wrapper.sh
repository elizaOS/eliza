#!/usr/bin/env bash
set -e

# ============================================
# Ralphy Wrapper for Autonomous Agent Env
# Integrates OpenCode with a PRD-driven loop
# ============================================

PRD_FILE="${1:-PRD.md}"
PROGRESS_FILE=".ralphy_progress.txt"

if [ ! -f "$PRD_FILE" ]; then
    echo "❌ PRD file not found: $PRD_FILE"
    echo "Usage: ./ralphy-wrapper.sh [PRD.md]"
    exit 1
fi

echo "🐇 Ralphy Wrapper initialized for: $PRD_FILE"
echo "   Monitor progress in: $PROGRESS_FILE"
echo ""

# Loop through tasks
while true; do
    # Find next incomplete task (first "- [ ] ..." line)
    # Using grep to find line number and task content
    NEXT_TASK_LINE=$(grep -n "\- \[ \]" "$PRD_FILE" | head -n 1)

    if [ -z "$NEXT_TASK_LINE" ]; then
        echo "✅ All tasks in $PRD_FILE are completed! 🎉"
        break
    fi

    # Extract line number and task description
    LINE_NUM=$(echo "$NEXT_TASK_LINE" | cut -d: -f1)
    TASK_DESC=$(echo "$NEXT_TASK_LINE" | cut -d: -f2- | sed 's/- \[ \] //')

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🚀 Executing Task: $TASK_DESC"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Log start
    echo "$(date): START '$TASK_DESC'" >> "$PROGRESS_FILE"

    # Construct Prompt
    PROMPT="You are an autonomous developer agent.
Your current task is from the PRD:
$TASK_DESC

Instructions:
1. Implement the solution fully.
2. Edit the file '$PRD_FILE' and mark this specific task as completed by changing '- [ ]' to '- [x]'.
3. Verify your work if possible.
"

    # Run OpenCode in full-auto mode
    # Assuming 'opencode' is in the PATH and configured via environment
    opencode run "$PROMPT"

    # Check if task was actually marked done (simple verification)
    # We re-read the specific line to see if it changed
    CURRENT_LINE_CONTENT=$(sed "${LINE_NUM}q;d" "$PRD_FILE")
    
    if [[ "$CURRENT_LINE_CONTENT" == *"- [x]"* ]]; then
        echo "✅ Task marked as completed."
        echo "$(date): DONE '$TASK_DESC'" >> "$PROGRESS_FILE"
    else
        echo "⚠️  Task finished but PRD not updated. Marking manually..."
        # Force update the line from [ ] to [x]
        sed -i "${LINE_NUM}s/- \[ \]/- [x]/" "$PRD_FILE"
        echo "$(date): FORCE_DONE '$TASK_DESC'" >> "$PROGRESS_FILE"
    fi

    echo ""
    sleep 2
done
