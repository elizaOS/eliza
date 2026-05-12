---
name: lean4-memories
description: This skill should be used when working on Lean 4 formalization projects to maintain persistent memory of successful proof patterns, failed approaches, project conventions, and user preferences across sessions using MCP memory server integration
---

# Lean 4 Memories

## Overview

This skill enables persistent learning and knowledge accumulation across Lean 4 formalization sessions by leveraging MCP (Model Context Protocol) memory servers. It transforms stateless proof assistance into a learning system that remembers successful patterns, avoids known dead-ends, and adapts to project-specific conventions.

**Core principle:** Learn from each proof session and apply accumulated knowledge to accelerate future work.

## When to Use This Skill

This skill applies when working on Lean 4 formalization projects, especially:
- **Multi-session projects** - Long-running formalizations spanning days/weeks/months
- **Repeated proof patterns** - Similar theorems requiring similar approaches
- **Complex proofs** - Theorems with multiple attempted approaches
- **Team projects** - Shared knowledge across multiple developers
- **Learning workflows** - Building up domain-specific proof expertise

**Especially important when:**
- Starting a new session on an existing project
- Encountering a proof pattern similar to previous work
- Trying an approach that previously failed
- Needing to recall project-specific conventions
- Building on successful proof strategies from earlier sessions

## How Memory Integration Works

### Memory Scoping

All memories are scoped by:
1. **Project path** - Prevents cross-project contamination
2. **Skill context** - Memories tagged with `lean4-memories`
3. **Entity type** - Structured by pattern type (ProofPattern, FailedApproach, etc.)

**Example scoping:**
```
Project: /Users/freer/work/exch-repos/exchangeability-cursor
Skill: lean4-memories
Entity: ProofPattern:condExp_unique_pattern
```

### Memory Types

**1. ProofPattern** - Successful proof strategies
```
Store when: Proof completes successfully after exploration
Retrieve when: Similar goal pattern detected
```

**2. FailedApproach** - Known dead-ends to avoid
```
Store when: Approach attempted but failed/looped/errored
Retrieve when: About to try similar approach
```

**3. ProjectConvention** - Code style and patterns
```
Store when: Consistent pattern observed (naming, structure, tactics)
Retrieve when: Creating new definitions/theorems
```

**4. UserPreference** - Workflow customization
```
Store when: User expresses preference (verbose output, specific tools, etc.)
Retrieve when: Choosing between options
```

**5. TheoremDependency** - Relationships between theorems
```
Store when: One theorem proves useful for proving another
Retrieve when: Looking for helper lemmas
```

## Memory Workflows

### Storing Memories

**After successful proof:**
```lean
-- Just proved: exchangeable_iff_fullyExchangeable
-- Store the successful pattern
```

Store:
- Goal pattern: `exchangeable X ↔ fullyExchangeable X`
- Successful tactics: `[apply measure_eq_of_fin_marginals_eq, intro, simp]`
- Helper lemmas used: `[prefixCylinder_measurable, isPiSystem_prefixCylinders]`
- Difficulty: medium (54 lines)
- Confidence: high (proof clean, no warnings)

**After failed approach:**
```lean
-- Attempted: simp only [condExp_indicator, mul_comm]
-- Result: infinite loop, build timeout
```

Store:
- Failed tactic: `simp only [condExp_indicator, mul_comm]`
- Error: "infinite simp loop"
- Context: conditional expectation with indicator
- Recommendation: "Use simp only [condExp_indicator] without mul_comm"

**Project conventions observed:**
```lean
-- Pattern: All measure theory proofs start with haveI
haveI : MeasurableSpace Ω := inferInstance
```

Store:
- Convention: "Measure theory proofs require explicit MeasurableSpace instance"
- Pattern: `haveI : MeasurableSpace Ω`
- Frequency: 15 occurrences
- Files: DeFinetti/ViaL2.lean, Core.lean, Contractability.lean

### Retrieving Memories

**Starting new proof session:**
1. Load project-specific conventions
2. Retrieve similar proof patterns from past work
3. Surface any known issues with current file/module

**Encountering similar goal:**
```
⊢ condExp μ m X =ᵐ[μ] condExp μ m Y

Memory retrieved: "Similar goals proved using condExp_unique"
Pattern: "Show ae_eq, verify measurability, apply condExp_unique"
Success rate: 3/3 in this project
```

**Before trying a tactic:**
```
About to: simp only [condExp_indicator, mul_comm]

Memory retrieved: ⚠️ WARNING - This combination causes infinite loop
Failed in: ViaL2.lean:2830 (2025-10-17)
Alternative: Use simp only [condExp_indicator], then ring
```

## Integration with lean4-theorem-proving Skill

The lean4-memories skill complements (doesn't replace) lean4-theorem-proving:

**lean4-theorem-proving provides:**
- General Lean 4 workflows (4-Phase approach)
- mathlib search and tactics reference
- Automation scripts
- Domain-specific knowledge (measure theory, probability)

**lean4-memories adds:**
- Project-specific learned patterns
- History of what worked/failed in this project
- Accumulated domain expertise from your proofs
- Personalized workflow preferences

**Use together:**
1. lean4-theorem-proving guides general workflow
2. lean4-memories provides project-specific context
3. Memories inform tactics choices from lean4-theorem-proving

## Memory Operations

### Storing a Successful Proof Pattern

After completing a proof, store the pattern using MCP memory:

**What to capture:**
- **Goal pattern** - Type/structure of goal (equality, exists, forall, etc.)
- **Tactics sequence** - Tactics that worked, in order
- **Helper lemmas** - Key lemmas applied
- **Difficulty** - Lines of proof, complexity estimate
- **Confidence** - Clean proof vs sorries/warnings
- **Context** - File, module, theorem name

**When to store:**
- Proof completed successfully (no sorries)
- Non-trivial (>10 lines or required exploration)
- Likely to be useful again (similar theorems expected)

**Storage format:**
```
Entity type: ProofPattern
Name: {descriptive_name}
Attributes:
  - project: {absolute_path}
  - goal_pattern: {pattern_description}
  - tactics: [list, of, tactics]
  - helper_lemmas: [lemma1, lemma2]
  - difficulty: {small|medium|large}
  - confidence: {0.0-1.0}
  - file: {filename}
  - timestamp: {date}
```

### Storing a Failed Approach

When an approach fails (error, loop, timeout), store to avoid repeating:

**What to capture:**
- **Failed tactic** - Exact tactic/sequence that failed
- **Error type** - Loop, timeout, type error, etc.
- **Context** - What was being proved
- **Alternative** - What worked instead (if known)

**When to store:**
- Infinite simp loops
- Tactics causing build timeouts
- Type mismatches from subtle issues
- Approaches that seemed promising but didn't work

**Storage format:**
```
Entity type: FailedApproach
Name: {descriptive_name}
Attributes:
  - project: {absolute_path}
  - failed_tactic: {tactic_text}
  - error: {error_description}
  - context: {what_was_being_proved}
  - alternative: {what_worked}
  - timestamp: {date}
```

### Storing Project Conventions

Track consistent patterns that emerge:

**What to capture:**
- **Naming conventions** - h_ for hypotheses, have_ for results
- **Proof structure** - Standard opening moves (haveI, intro patterns)
- **Import patterns** - Commonly used imports
- **Tactic preferences** - measurability vs explicit proofs

**When to store:**
- Pattern observed 3+ times consistently
- Convention affects multiple files
- Style guide established

### Retrieving Memories

**Before starting proof:**
```
1. Query for similar goal patterns
2. Surface successful tactics for this pattern
3. Check for known issues with current context
4. Suggest helper lemmas from similar proofs
```

**During proof:**
```
1. Before each major tactic, check for known failures
2. When stuck, retrieve alternative approaches
3. Suggest next tactics based on past success
```

**Query patterns:**
```
# Find similar proofs
search_entities(
  query="condExp equality goal",
  filters={"project": current_project, "entity_type": "ProofPattern"}
)

# Check for failures
search_entities(
  query="simp only condExp_indicator",
  filters={"project": current_project, "entity_type": "FailedApproach"}
)

# Get conventions
search_entities(
  query="naming conventions measure theory",
  filters={"project": current_project, "entity_type": "ProjectConvention"}
)
```

## Best Practices

### Memory Quality

**DO store:**
- ✅ Successful non-trivial proofs (>10 lines)
- ✅ Failed approaches that wasted significant time
- ✅ Consistent patterns observed multiple times
- ✅ Project-specific insights

**DON'T store:**
- ❌ Trivial proofs (rfl, simp, exact)
- ❌ One-off tactics unlikely to recur
- ❌ General Lean knowledge (already in training/mathlib)
- ❌ Temporary workarounds

### Memory Hygiene

**Confidence scoring:**
- **High (0.8-1.0)** - Clean proof, no warnings, well-tested
- **Medium (0.5-0.8)** - Works but has minor issues
- **Low (0.0-0.5)** - Hacky solution, needs refinement

**Aging:**
- Recent memories (same session) = higher relevance
- Older memories = verify still applicable
- Patterns from many sessions = high confidence

**Pruning:**
- Remove memories for deleted theorems
- Update when better approach found
- Mark as outdated if project evolves

### User Control

**Users can:**
- Toggle lean4-memories skill on/off independently
- Clear project-specific memories
- Review stored memories
- Adjust confidence thresholds
- Export/import memories for sharing

## Example Workflow

**Session 1: First proof**
```lean
-- Proving: measure_eq_of_fin_marginals_eq
-- No memories yet, explore from scratch
-- [After 30 minutes of exploration]
-- ✅ Success with π-system uniqueness approach

Store: ProofPattern "pi_system_uniqueness"
  - Works for: measure equality via finite marginals
  - Tactics: [isPiSystem, generateFrom_eq, measure_eq_on_piSystem]
  - Confidence: 0.9
```

**Session 2: Similar theorem (weeks later)**
```lean
-- Proving: fullyExchangeable_via_pathLaw
-- Goal: Show two measures equal
-- System: "Similar to measure_eq_of_fin_marginals_eq"
--         Retrieve memory: pi_system_uniqueness pattern
--         Suggestion: "Try isPiSystem approach?"

-- ✅ Success in 5 minutes using remembered pattern
```

**Session 3: Avoiding failure**
```lean
-- Proving: condIndep_of_condExp_eq
-- About to: simp only [condExp_indicator, mul_comm]
-- ⚠️ Memory: This causes infinite loop (stored Session 1)
--          Alternative: simp only [condExp_indicator], then ring

-- Avoid 20-minute debugging session by using memory
```

## Configuration

### Memory Server Setup

Ensure MCP memory server is configured:

```json
// In Claude Desktop config
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

### Project-Specific Settings

Memories are automatically scoped by project path. To work across multiple projects:

**Same formalization, different repos:**
```
# Link memories using project aliases
# (Future enhancement - not yet implemented)
```

**Sharing memories with team:**
```
# Export/import functionality
# (Future enhancement - not yet implemented)
```

## Integration with Automation Scripts

Memories enhance script usage:

**proof_templates.sh:**
- Retrieve project-specific template preferences
- Include common proof patterns in scaffolding

**suggest_tactics.sh:**
- Prioritize tactics that succeeded in this project
- Warn about tactics with known issues

**sorry_analyzer.py:**
- Link sorries to similar completed proofs
- Suggest approaches based on memory

## Limitations and Caveats

**What memories DON'T replace:**
- Mathematical understanding
- Lean type system knowledge
- mathlib API documentation
- Formal verification principles

**Potential issues:**
- Stale memories if project evolves significantly
- Over-fitting to specific project patterns
- Memory bloat if not maintained
- Cross-project contamination if scoping fails

**Mitigation:**
- Regular review of stored memories
- Confidence scoring and aging
- Strict project-path scoping
- User control over memory operations

## Future Enhancements

**Planned features:**
- Memory visualization dashboard
- Pattern mining across projects
- Collaborative memory sharing
- Automated memory pruning
- Integration with git history
- Cross-project pattern detection (with user consent)

## See Also

- **lean4-theorem-proving skill** - Core workflows and automation
- **MCP memory server docs** - https://modelcontextprotocol.io/docs/getting-started/intro
- **references/memory-patterns.md** - Detailed memory operation examples
