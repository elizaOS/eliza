# InterruptBench Report

- Mode: cerebras
- Model: gemma-4-31b
- Started: 2026-07-02T06:02:51.974Z
- Finished: 2026-07-02T06:03:29.574Z
- Aggregate: **97.07**
- Judge bonus: 0.00
- Final score: **97.07**
- Pass tier: **95**

## Per-scenario

| ID | Category | Weight | Score | Boundary | State | Intent | Routing | Trace | Latency | Judge |
|---|---|---|---|---|---|---|---|---|---|---|
| A1-fragmented-email-draft | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction | A | 3 | 85.0 | ok | 50 | 100 | 100 | 100 | 100 | — |
| B1-pure-cancellation | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 | 100 | — |
| B2-destructive-cancellation | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| C1-mid-task-steering | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| D1-cross-channel-leak | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-polite | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-urgent | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-mobile | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-followup | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-quoted | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-context | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-ack | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-noisy | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-boundary | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A1-fragmented-email-draft--edge-handoff | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-polite | A | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-urgent | A | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-mobile | A | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-followup | A | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-quoted | A | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-context | A | 3 | 85.0 | ok | 50 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-ack | A | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-noisy | A | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-boundary | A | 3 | 85.0 | ok | 50 | 100 | 100 | 100 | 100 | — |
| A4-stream-with-retraction--edge-handoff | A | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B1-pure-cancellation--edge-polite | B | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B1-pure-cancellation--edge-urgent | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 | 100 | — |
| B1-pure-cancellation--edge-mobile | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 | 100 | — |
| B1-pure-cancellation--edge-followup | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 | 100 | — |
| B1-pure-cancellation--edge-quoted | B | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B1-pure-cancellation--edge-context | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 | 100 | — |
| B1-pure-cancellation--edge-ack | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 | 100 | — |
| B1-pure-cancellation--edge-noisy | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 | 100 | — |
| B1-pure-cancellation--edge-boundary | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 | 100 | — |
| B1-pure-cancellation--edge-handoff | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 | 100 | — |
| B2-destructive-cancellation--edge-polite | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B2-destructive-cancellation--edge-urgent | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B2-destructive-cancellation--edge-mobile | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B2-destructive-cancellation--edge-followup | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B2-destructive-cancellation--edge-quoted | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B2-destructive-cancellation--edge-context | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B2-destructive-cancellation--edge-ack | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B2-destructive-cancellation--edge-noisy | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B2-destructive-cancellation--edge-boundary | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| B2-destructive-cancellation--edge-handoff | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-polite | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-urgent | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-mobile | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-followup | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-quoted | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-context | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-ack | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-noisy | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-boundary | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| C1-mid-task-steering--edge-handoff | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-polite | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-urgent | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-mobile | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-followup | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-quoted | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-context | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-ack | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-noisy | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-boundary | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| D1-cross-channel-leak--edge-handoff | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-polite | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-urgent | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-mobile | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-followup | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-quoted | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-context | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-ack | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-noisy | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-boundary | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| F1-pivot-within-thread--edge-handoff | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-polite | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-urgent | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-mobile | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-followup | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-quoted | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-context | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-ack | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-noisy | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-boundary | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| G1-cross-channel-prompt-resolution--edge-handoff | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-polite | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-urgent | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-mobile | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-followup | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-quoted | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-context | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-ack | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-noisy | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-boundary | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| H1-concurrent-merge--edge-handoff | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly--edge-polite | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly--edge-urgent | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly--edge-mobile | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly--edge-followup | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly--edge-quoted | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly--edge-context | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly--edge-ack | K | 2 | 50.0 | ok | 0 | 100 | 0 | 100 | 100 | — |
| K1-recipe-assembly--edge-noisy | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly--edge-boundary | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |
| K1-recipe-assembly--edge-handoff | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 | 100 | — |

## Notes (per scenario)

### A1-fragmented-email-draft
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction
  - [state] scheduledTask mismatch: expected {"owner":"alice","descriptionContains":["carol","friday","10"],"descriptionExcludes":["tomorrow","3pm"]}
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation
  - [trace] abortFired=false, expected true
  - [trace] preemptMode=(none), expected ack-and-stop
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-polite
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-urgent
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-mobile
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-followup
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-quoted
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-context
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-ack
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-noisy
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-boundary
  - [latency] latency axis skipped for cerebras mode

### A1-fragmented-email-draft--edge-handoff
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-polite
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-urgent
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-mobile
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-followup
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-quoted
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-context
  - [state] scheduledTask mismatch: expected {"owner":"alice","descriptionContains":["carol","friday","10"],"descriptionExcludes":["tomorrow","3pm"]}
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-ack
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-noisy
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-boundary
  - [state] scheduledTask mismatch: expected {"owner":"alice","descriptionContains":["carol","friday","10"],"descriptionExcludes":["tomorrow","3pm"]}
  - [latency] latency axis skipped for cerebras mode

### A4-stream-with-retraction--edge-handoff
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-polite
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-urgent
  - [trace] abortFired=false, expected true
  - [trace] preemptMode=(none), expected ack-and-stop
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-mobile
  - [trace] abortFired=false, expected true
  - [trace] preemptMode=(none), expected ack-and-stop
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-followup
  - [trace] abortFired=false, expected true
  - [trace] preemptMode=(none), expected ack-and-stop
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-quoted
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-context
  - [trace] abortFired=false, expected true
  - [trace] preemptMode=(none), expected ack-and-stop
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-ack
  - [trace] abortFired=false, expected true
  - [trace] preemptMode=(none), expected ack-and-stop
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-noisy
  - [trace] abortFired=false, expected true
  - [trace] preemptMode=(none), expected ack-and-stop
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-boundary
  - [trace] abortFired=false, expected true
  - [trace] preemptMode=(none), expected ack-and-stop
  - [latency] latency axis skipped for cerebras mode

### B1-pure-cancellation--edge-handoff
  - [trace] abortFired=false, expected true
  - [trace] preemptMode=(none), expected ack-and-stop
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-polite
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-urgent
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-mobile
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-followup
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-quoted
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-context
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-ack
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-noisy
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-boundary
  - [latency] latency axis skipped for cerebras mode

### B2-destructive-cancellation--edge-handoff
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-polite
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-urgent
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-mobile
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-followup
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-quoted
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-context
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-ack
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-noisy
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-boundary
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### C1-mid-task-steering--edge-handoff
  - [intent] expected intent RESPOND, observed IGNORE
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-polite
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-urgent
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-mobile
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-followup
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-quoted
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-context
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-ack
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-noisy
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-boundary
  - [latency] latency axis skipped for cerebras mode

### D1-cross-channel-leak--edge-handoff
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-polite
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-urgent
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-mobile
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-followup
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-quoted
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-context
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-ack
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-noisy
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-boundary
  - [latency] latency axis skipped for cerebras mode

### F1-pivot-within-thread--edge-handoff
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-polite
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-urgent
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-mobile
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-followup
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-quoted
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-context
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-ack
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-noisy
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-boundary
  - [latency] latency axis skipped for cerebras mode

### G1-cross-channel-prompt-resolution--edge-handoff
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-polite
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-urgent
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-mobile
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-followup
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-quoted
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-context
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-ack
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-noisy
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-boundary
  - [latency] latency axis skipped for cerebras mode

### H1-concurrent-merge--edge-handoff
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-polite
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-urgent
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-mobile
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-followup
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-quoted
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-context
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-ack
  - [state] reply count for dm-alice: got 0, expected 1-1
  - [state] reply in dm-alice missing required content: recipe
  - [routing] channel dm-alice expected >=1 replies
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-noisy
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-boundary
  - [latency] latency axis skipped for cerebras mode

### K1-recipe-assembly--edge-handoff
  - [latency] latency axis skipped for cerebras mode
