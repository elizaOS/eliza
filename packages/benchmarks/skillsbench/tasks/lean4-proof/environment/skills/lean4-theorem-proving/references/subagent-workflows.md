# Subagent Workflows for Lean 4 Development

**For Claude Code users:** This guide shows how to leverage subagents to automate mechanical tasks while keeping your main conversation focused on proof strategy.

## Overview

**Core principle:** Delegate mechanical tasks to specialized subagents, keep proof development in main conversation.

**Benefits:**
- **6x token reduction** vs running scripts directly
- **Parallel execution** - subagent runs while you continue working
- **Cleaner conversation** - focus on proof strategy, not script output
- **Consistent patterns** - all scripts designed for subagent delegation

## Quick Reference

**Key takeaways:**

1. **Delegate mechanical tasks** - search, analysis, verification
2. **Keep strategic work** - proof development, design decisions
3. **Use Explore agents** - for most script execution (fast, cheap)
4. **Be specific** - tell agent exactly what to report
5. **Batch operations** - combine related tasks in one dispatch
6. **6x token savings** - measured benefit across typical session

**Remember:** The goal is to keep your main conversation focused on **proof strategy and tactics**, while automating everything else.

## Agent Types

### Explore Agent (Fast, Lightweight)

**Use for:**
- Quick searches and file discovery
- Running single scripts with straightforward output
- Pattern matching and grepping

**Tools available:** Glob, Grep, Read, Bash

**Cost:** ~Haiku-level tokens

**When to use:**
- "Find all files using MeasurableSpace"
- "Run sorry_analyzer.py and report count"
- "Search mathlib for continuous function lemmas"

### General-Purpose Agent (Thorough, Multi-Step)

**Use for:**
- Complex searches requiring judgment
- Multi-step analysis workflows
- Tasks that need interpretation

**Tools available:** Full toolset including Task

**Cost:** ~Sonnet-level tokens

**When to use:**
- "Search mathlib, evaluate which lemmas apply, recommend best 3"
- "Analyze proof complexity and suggest refactoring priorities with reasoning"
- "Compare multiple proof approaches and explain tradeoffs"

### Specialized Subagents (lean4-subagents Plugin)

**Optional plugin:** If you have the `lean4-subagents` plugin installed, three specialized subagents are available:

**1. lean4-proof-golfer**
- **Purpose:** Systematically optimize Lean 4 proofs with false-positive filtering
- **When to use:** After proofs compile successfully to achieve 30-40% size reduction
- **Key feature:** MUST verify safety with analyze_let_usage.py before inlining let bindings
- **Integration:** Works with /golf-proofs slash command

**2. lean4-sorry-filler**
- **Purpose:** Fill incomplete proofs (sorries) using mathlib search and multi-candidate testing
- **When to use:** When tackling incomplete proofs systematically
- **Key feature:** Searches mathlib first (90% success rate), generates 2-3 candidates, tests in parallel
- **Integration:** Works with /fill-sorry and /analyze-sorries slash commands

**3. lean4-axiom-eliminator**
- **Purpose:** Systematically eliminate axioms and sorries from Lean 4 proofs
- **When to use:** After checking axiom hygiene to reduce axiom count to zero
- **Key feature:** Exhaustive mathlib search, prioritizes high-impact axioms, tracks elimination progress
- **Integration:** Works with /check-axioms slash command

**How these differ from Explore/General-Purpose:**
- **Specialized workflows:** Each has a domain-specific multi-phase workflow
- **Built-in best practices:** Encode lessons learned from proof development sessions
- **Autonomous operation:** Can work through entire batches of similar tasks
- **Quality gates:** Built-in safety checks and verification steps

**When to use specialized vs general subagents:**
```
Task: "Optimize these 5 proofs"
✅ Dispatch lean4-proof-golfer (specialized workflow with safety checks)
❌ Dispatch general-purpose agent to run find_golfable.py (misses false-positive filtering)

Task: "Find mathlib lemmas for this sorry"
✅ Dispatch Explore agent to run smart_search.sh (simple delegation)
❌ Dispatch lean4-sorry-filler (overkill for single search)

Task: "Fill all 15 sorries in this file"
✅ Dispatch lean4-sorry-filler (batch processing with testing)
❌ Manual iteration in main conversation (inefficient)
```

## When to Dispatch Subagents

### ✅ Dispatch Subagents For

**Search tasks:**
- Finding mathlib lemmas by keyword or pattern
- Discovering type class instances
- Locating similar proofs or patterns

**Analysis tasks:**
- Proof complexity metrics across files
- Dependency graph generation
- Sorry reports and statistics

**Verification tasks:**
- Checking axioms across multiple files
- Batch compilation verification
- Import consistency checks

**Exploratory tasks:**
- Understanding unfamiliar codebase structure
- Finding all usages of a definition
- Discovering available tactics or notation

### ❌ Keep in Main Conversation

**Proof development:**
- Writing tactics and structuring arguments
- Responding to type checker errors
- Making tactical decisions (which tactic to try next)

**Design decisions:**
- Choosing between proof approaches
- Breaking theorems into subgoals
- Architectural decisions

**Error debugging:**
- Interpreting "failed to synthesize instance" errors
- Understanding type mismatches
- Resolving compilation errors

**Strategic planning:**
- Planning proof outline
- Identifying helper lemmas needed
- Deciding which sorry to tackle next

## Automation Scripts + Subagents

### Pattern: Delegate Script Execution

**Instead of this (inefficient):**
```
You: Run scripts/sorry_analyzer.py on the whole project

Claude (in main conversation):
[Executes script directly]
[Displays 100 lines of output]
[Consumes 500+ tokens explaining results]
```

**Do this (efficient):**
```
You: Dispatch an Explore agent to run scripts/sorry_analyzer.py and report top 5 sorries

Claude (in main conversation):
"I'm dispatching an Explore agent to analyze sorries..."
[Uses Task tool with Explore agent]
[Agent reports back with summary]
"The agent found 47 sorries. Top 5 to tackle:
 1. convergence_proof (line 245) - needs monotone convergence theorem
 2. helper_bound (line 189) - straightforward inequality
 ..."
```

## Example Workflows

### Finding Mathlib Lemmas

**Task:** "I need lemmas about continuous functions on compact spaces"

**Efficient approach:**
```
Claude: "I'm dispatching an Explore agent to search for relevant lemmas..."

[Dispatches with prompt]:
"Run scripts/smart_search.sh 'continuous functions compact spaces' --source=leansearch
 and report the top 3 most relevant results with their import paths"

[Agent reports back]:
1. Continuous.isCompact_range - Mathlib.Topology.Compactness.Compact
2. IsCompact.image_of_continuous - Mathlib.Topology.Compactness.Basic
3. compact_space_image - Mathlib.Topology.Compactness.Compact

Claude: "Perfect! Let's use Continuous.isCompact_range. Let me add the import..."
```

**Token savings:** ~600 tokens (script output + explanation) → ~100 tokens (dispatch + summary)

### Analyzing Proof Complexity

**Task:** "Which proofs should I refactor first?"

**Efficient approach:**
```
Claude: "Let me dispatch an Explore agent to analyze proof complexity..."

[Dispatches with prompt]:
"Run scripts/proof_complexity.sh src/ --sort-by=lines and report:
 1. Top 10 most complex proofs by line count
 2. How many proofs are >100 lines (huge category)
 3. Any proofs with sorries that are also large"

[Agent reports back]:
Top 10:
1. main_convergence_theorem (245 lines, 2 sorries)
2. helper_l2_bound (180 lines, 0 sorries)
...

Summary: 3 proofs >100 lines, 2 have sorries

Claude: "Let's refactor main_convergence_theorem first. It's large AND has sorries.
Looking at the structure, I can see 3 natural subgoals we can extract..."
```

### Pre-Commit Verification

**Task:** "Ready to commit - verify everything is clean"

**Efficient batch approach:**
```
Claude: "I'm dispatching an Explore agent to run verification checks..."

[Dispatches with prompt]:
"Run the following verification tasks and report summary:
 1. scripts/sorry_analyzer.py src/ --format=json (count sorries)
 2. scripts/check_axioms_inline.sh 'src/**/*.lean' (check for non-standard axioms)
 3. Report: Total sorries, any axiom issues, ready to commit?"

[Agent reports back]:
- Sorries: 3 total (all documented with TODO comments)
- Axioms: All 150 declarations use only standard axioms
- Ready: Yes, all checks passed

Claude: "Excellent! All verification checks passed. Let's commit with message:
'feat: Complete convergence proof - 3 documented sorries remain'"
```

### Interactive Sorry Selection

**Task:** "What should I work on next?"

**Hybrid approach (user-interactive):**
```
Claude: "Let's use the interactive sorry navigator. This runs on your terminal
so you can browse and select which sorry to tackle."

You (in terminal):
$ scripts/sorry_analyzer.py . --interactive

[TUI shows]:
Files with sorries:
  [1] src/Convergence.lean (5 sorries)
  [2] src/Helpers.lean (2 sorries)

[You select file 1, then sorry 3]:
Line 245 - theorem convergence_main
  TODO: Need monotone convergence theorem from mathlib

[You press 'o 3' to open in $EDITOR]

You (returning to conversation): "I'm working on the convergence proof at line 245"

Claude: "Great choice! That sorry needs monotone convergence. Let me dispatch an agent
to find the right mathlib lemma..."
```

## Subagent Dispatch Patterns

### Pattern 1: Simple Delegation

**When:** Single script, straightforward task

**Example:**
```
"Dispatch Explore agent to run scripts/find_instances.sh MeasurableSpace
 and report how many instances were found"
```

**Template:**
```
"Dispatch Explore agent to run scripts/[SCRIPT] [ARGS] and report [WHAT_YOU_NEED]"
```

### Pattern 2: Batch Operations

**When:** Multiple related scripts, combine results

**Example:**
```
"Dispatch Explore agent to:
 1. Run scripts/sorry_analyzer.py src/ and report total count
 2. Run scripts/check_axioms_inline.sh 'src/**/*.lean' and report any issues
 3. Run scripts/proof_complexity.sh src/ --sort-by=sorries and report top 5
 4. Summarize: What's the state of the codebase?"
```

**Template:**
```
"Dispatch Explore agent to:
 1. [TASK 1]
 2. [TASK 2]
 3. [TASK 3]
 4. Summarize: [SYNTHESIS_QUESTION]"
```

### Pattern 3: Iterative Search

**When:** Multi-step search requiring judgment

**Example:**
```
"Dispatch general-purpose agent to:
 1. Search mathlib for continuous function lemmas using scripts/smart_search.sh
 2. Filter results to those mentioning compact spaces
 3. For top 3 results, check their type signatures
 4. Recommend which lemma best fits our use case: proving f(K) is compact when K is compact
 5. Report: Recommended lemma, import path, why it's the best fit"
```

**Template:**
```
"Dispatch general-purpose agent to:
 1. [SEARCH]
 2. [FILTER/EVALUATE]
 3. [DEEPER_ANALYSIS]
 4. [RECOMMEND]
 5. Report: [SPECIFIC_DELIVERABLE]"
```

### Pattern 4: Exploratory Investigation

**When:** Understanding unfamiliar code or patterns

**Example:**
```
"Dispatch Explore agent to investigate how conditional expectation is used in this project:
 1. Run scripts/search_mathlib.sh 'condExp' name in project files (not mathlib)
 2. Read the top 3 files that use it most
 3. Report: What patterns do you see? How is it typically combined with other operations?"
```

**Template:**
```
"Dispatch Explore agent to investigate [TOPIC]:
 1. [FIND_RELEVANT_FILES]
 2. [READ/ANALYZE]
 3. Report: [PATTERNS_OR_INSIGHTS]"
```

## Cost-Benefit Analysis

### Token Economics

**Scenario:** Running sorry_analyzer.py on a medium project

**Without subagent (direct execution):**
- Script output: ~500 tokens (100 lines @ 5 tokens/line)
- Claude explanation: ~200 tokens
- **Total: ~700 tokens**
- Uses main conversation tokens (expensive)

**With subagent delegation:**
- Dispatch prompt: ~50 tokens
- Agent summary: ~50 tokens
- Claude response: ~50 tokens
- **Total: ~150 tokens in main conversation**
- Agent uses Haiku/fast model (cheap)
- **Savings: 700 → 150 = 78% reduction**

**Multiplied across a session:** 10 searches = 7000 tokens → 1500 tokens = **5500 tokens saved**

### When NOT to Use Subagents

**Single-file operations:**
```
❌ "Dispatch agent to grep for 'sorry' in MyFile.lean"
✅ Just use Grep tool directly
```

**Immediate tactical decisions:**
```
❌ "Dispatch agent to look at this type error and suggest a tactic"
✅ Interpret error yourself in main conversation
```

**Already have the information:**
```
❌ "Dispatch agent to check if file compiles" (you just saw it compile)
✅ Proceed with next step
```

**Small proofs (<20 lines):**
```
❌ "Dispatch agent to analyze complexity of this 15-line proof"
✅ Just read it directly
```

## Integration with MCP Server

**If Lean MCP server is available:** Prefer MCP tools over scripts.

**Hierarchy:**
1. **MCP server** (best) - Direct integration, no script overhead
2. **Subagent + scripts** (good) - Efficient delegation, batch operations
3. **Direct script execution** (fallback) - When not using Claude Code

**MCP + Subagents workflow:**
```
# Use MCP for interactive proof development
mcp__lean-lsp__lean_goal(file, line, column)  # See proof state
mcp__lean-lsp__lean_diagnostic_messages(file)  # Check errors

# Delegate batch operations to subagents
"Dispatch Explore agent to run scripts/check_axioms_inline.sh on all changed files"
```

**Why this combination?**
- MCP: Real-time feedback during proof development
- Subagents: Batch verification and analysis tasks
- Best of both: Interactive + Automated

## Best Practices

### Do

✅ **Dispatch early and often** - Don't wait until script output overwhelms conversation

✅ **Be specific about what you need** - "report top 3 results" not "run and show me everything"

✅ **Use Explore agents for scripts** - They're designed for tool execution

✅ **Batch related tasks** - Combine multiple scripts in one dispatch

✅ **Request summaries** - Ask agent to synthesize, not just dump output

### Don't

❌ **Don't dispatch for trivial tasks** - Use tools directly when simpler

❌ **Don't dispatch for proof tactics** - Keep proof development in main conversation

❌ **Don't forget to specify output** - Agent needs to know what to report back

❌ **Don't dispatch when you have the answer** - Only delegate actual work

❌ **Don't use general-purpose for simple scripts** - Explore agent is faster

## Using Slash Commands from Subagents

### When Subagents Should Use Slash Commands

Subagents can invoke slash commands using the `SlashCommand` tool. This is useful for accessing specialized workflows that combine multiple steps.

**Available slash commands:**
- `/lean4-theorem-proving:search-mathlib [query]` - Search mathlib with multiple strategies
- `/lean4-theorem-proving:analyze-sorries` - Analyze and categorize incomplete proofs
- `/lean4-theorem-proving:fill-sorry [file:line]` - Interactive sorry filling
- `/lean4-theorem-proving:check-axioms [file]` - Verify axiom hygiene
- `/lean4-theorem-proving:build-lean` - Build with error analysis
- `/lean4-theorem-proving:golf-proofs [file]` - Optimize proofs interactively
- `/lean4-theorem-proving:clean-warnings` - Clean linter warnings by category

**When to use slash commands vs scripts directly:**

✅ **Use slash command when:**
- Workflow combines multiple steps (search + filter + recommend)
- Interactive decision-making is needed
- You want standardized output formatting
- Example: `/search-mathlib` combines local search, leansearch, and loogle APIs

❌ **Use script directly when:**
- Single-step operation
- Just need raw output for further processing
- Non-standard arguments needed
- Example: `scripts/search_mathlib.sh "pattern" name`

### Example: Subagent Using Slash Command

**Scenario:** Main conversation asks subagent to find and recommend lemmas

**Subagent task:**
```
"Dispatch general-purpose agent to find lemmas about continuous functions on compact spaces.
Use /search-mathlib, evaluate results, and recommend the best fit for our use case."
```

**Subagent execution:**
```python
# Subagent uses SlashCommand tool
SlashCommand("/lean4-theorem-proving:search-mathlib continuous compact")

# Slash command runs, returns results
# Subagent evaluates and reports back:

"I found 8 relevant lemmas. Best fit for your use case:

**Recommended: Continuous.isCompact_image**
- Type: Continuous f → IsCompact s → IsCompact (f '' s)
- Import: Mathlib.Topology.Compactness.Compact
- Why: Directly proves continuous image of compact set is compact

Alternatives:
- ContinuousOn.isCompact_image (if only continuous on subset)
- IsCompact.image (more general form)
"
```

### Pattern: Script vs Slash Command Decision

**Use script directly (faster, simpler):**
```
"Dispatch Explore agent to:
Run scripts/sorry_analyzer.py . --format=text
and report total sorry count"
```

**Use slash command (richer workflow):**
```
"Dispatch Explore agent to:
Use /analyze-sorries to get categorized sorry breakdown
and report which category has the most sorries"
```

**Key difference:** Slash commands provide interpretation and next-step suggestions, scripts provide raw data.

## Troubleshooting

### "Agent didn't find what I expected"

**Problem:** Search came back empty or wrong results

**Solutions:**
- Check script arguments - did you pass the right pattern?
- Try different search mode (name vs content vs type)
- Dispatch with more specific instructions
- Fall back to MCP server tools if available

### "Agent output was too verbose"

**Problem:** Got 50 lines when you needed 5

**Solutions:**
- Be more specific: "report top 3" not "report all"
- Ask for summary: "summarize findings" not "show full output"
- Use filtering: "only report sorries with no TODO comments"

### "Not sure which agent type to use"

**Decision tree:**
```
Is it running a single script?
└─> Yes: Explore agent

Does it require judgment/reasoning?
└─> Yes: General-purpose agent

Is it multi-step with decisions?
└─> Yes: General-purpose agent

Otherwise:
└─> Explore agent (default choice)
```

See `scripts/README.md` for complete script documentation.
