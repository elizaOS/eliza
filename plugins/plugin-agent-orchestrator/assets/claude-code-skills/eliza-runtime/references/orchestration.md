# How Eliza's swarm-coordinator decides "complete" vs "continue"

When you finish a turn (your stdout goes idle for the cooldown window, typically 15s after `lastInputSentAt`), the PTY adapter emits a `task_complete` event to the orchestrator. The orchestrator then runs an LLM-backed assessment to decide what should happen next.

The decision tree:

```
task_complete event
    ↓
SwarmCoordinator.handleTurnComplete(sessionId)
    ↓
classifyEventTier()              ← routine vs creative
    ↓
[routine path]                   [creative path]
small-LLM assessor               Eliza pipeline
    ↓                             ↓
returns one of:
  "complete"   — your work is done, run validation
  "respond"    — you said something the user/parent should answer
                 (note: if your text is asking the user a question,
                  this auto-converts to "escalate")
  "escalate"   — needs human attention, parent broadcasts an event
  "ignore"     — output was status / no real progress
```

## What happens after each decision

### complete
1. orchestrator captures `completionSummary` from your last 50 lines of output
2. status flips to `tool_running` (validation phase)
3. validator LLM judges your work against the task brief + acceptance criteria
4. if validator says "approved" → status `completed`, synthesis fires
5. if validator says "revise" → orchestrator sends a follow-up prompt back into your PTY ("here's what's missing, please address")
6. if validator says "escalate" → broadcast escalation event but the answer in your jsonl is still surfaced via synthesis

### respond
- The orchestrator sends a follow-up prompt INTO your PTY (your stdin), not back to the human.
- If the assessor judges your "respond" content is actually you asking the human a question, it auto-converts to `escalate` to avoid feeding your question back to yourself in a loop.

### escalate
- A `swarm_attention_required` event is broadcast (web UI sees it)
- The agent's reasoning is included in the eventual synthesis output to the human
- Your PTY is force-stopped after the escalation is recorded

### ignore
- No-op. The PTY remains idle waiting for the next input or stall timeout.

## What you should DO

1. End each turn cleanly. Don't leave open background jobs (`&` in shell, half-finished `bun run`, etc.) — they cause repeated pseudo-task_complete cycles.
2. If you genuinely need human input ("which of these three options?"), say so plainly. The assessor catches this pattern and converts to `escalate`.
3. If you're done, end with a one-line summary. The validator + synthesis read your `completionSummary` (last 50 lines), so make those lines count.

## What you should NOT do

- Don't print "Done!" prematurely; you'll trigger task_complete before the work is verified.
- Don't pad your final message expecting it to "look complete" — completion is detected by output going idle, not by length.
- Don't try to call back into your own assessment ("orchestrator, please mark me complete") — there's no such API. Your stdout going quiet is the only signal.

## The cooldown grace

Between when you receive an input and when the orchestrator considers `task_complete`, there's a `cooldown` (15s by default). This prevents single-keystroke inputs from being misread as completed turns. You'll see log lines like:

```
Suppressing turn-complete for "agent-XXXX": 2s since last input (cooldown 15s)
```

These are normal. They mean the orchestrator is waiting out the grace before judging your turn. Don't try to defeat them.
