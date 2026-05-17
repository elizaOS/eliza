# Lean LSP Tools - API Reference

**Detailed API documentation for all Lean LSP MCP server tools.**

For workflow patterns and quick reference, see [lean-lsp-server.md](lean-lsp-server.md).

---

## Tool Categories

**Local tools (unlimited, instant):**
- Direct LSP queries against your project files
- No rate limits, < 1 second response time
- Tools: `lean_goal`, `lean_local_search`, `lean_multi_attempt`, `lean_diagnostic_messages`, `lean_hover_info`, `lean_file_outline`, `lean_run_code`

**External tools (rate-limited to 3 req/30s):**
- Remote API calls to loogle.lean-lang.org, leansearch.net
- Managed by LSP server to avoid overwhelming services
- Tools: `lean_loogle`, `lean_leansearch`, `lean_state_search`

**Best practice:** Always use local tools first (especially `lean_local_search`), then external tools only when local search doesn't find what you need.

---

## Local Tools (Unlimited)

### `lean_goal` - Check Proof State

**When to use:**
- Before writing ANY tactic
- After each tactic to see progress
- To understand what remains to be proved

**Parameters:**
- `file_path` (required): Absolute path to Lean file
- `line` (required): Line number (1-indexed)
- `column` (optional): Usually omit - shows both before/after line

**Example:**
```lean
lemma test_add_comm (n m : ℕ) : n + m = m + n := by
  sorry  -- <- Check goal here (line 12)
```

**Call:** `lean_goal(file, line=12)`

**Output (v0.17+):** Returns **structured goals list** (not just text):
```json
{
  "goals_before": [],
  "goals_after": [
    {"goal": "n + m = m + n", "hypotheses": ["n : ℕ", "m : ℕ"]}
  ]
}
```

**What this tells you:**
- Context: `n : ℕ, m : ℕ` (hypotheses)
- Goal: `n + m = m + n` (what you need to prove)
- Now you know exactly what tactic to search for!

**Pro tip:** Call `lean_goal` on a line WITH a tactic to see before/after states - shows exactly what that tactic accomplishes.

**Success signal (v0.17+):**
```json
{
  "goals_before": [...],
  "goals_after": []
}
```
← Empty `goals_after` array = proof complete!

---

### `lean_diagnostic_messages` - Instant Error Checking

**When to use:** After EVERY edit, before building

**Advantage:** Instant (< 1s) vs build (10-30s)

**Parameters:**
- `file_path` (required): Absolute path to Lean file
- `declaration_name` (optional): Filter diagnostics to a specific declaration (e.g., "myLemma"). Useful for large files with many errors.

**⚠️ IMPORTANT:** Do NOT pass `severity` parameter - it will cause error `'severity'`. Severity appears IN the response, not as a filter.

**Correct usage:**
```python
lean_diagnostic_messages(file_path="/path/to/file.lean")
# NOT: lean_diagnostic_messages(file_path="/path/to/file.lean", severity=1)
```

**Example - Errors found:**
```
lean_diagnostic_messages(file)
→ ["l13c9-l13c17, severity: 1\nUnknown identifier `add_comm`",
   "l20c30-l20c49, severity: 1\nFunction expected at StrictMono"]
```
- Line 13, columns 9-17: `add_comm` not in scope
- Line 20, columns 30-49: Syntax error with `StrictMono`
- Severity 1 = error, Severity 2 = warning (returned in response, not a parameter)

**Example - Success:**
```
lean_diagnostic_messages(file)
→ []
```
← Empty array = no errors!

**Critical:** Empty diagnostics means no errors, but doesn't mean proof complete. Always verify with `lean_goal` to confirm "no goals".

---

### `lean_local_search` - Find Declarations

**Why use this FIRST:**
- ✅ **Unlimited** - no rate limits
- ✅ **Instant** - fastest search option
- ✅ **Comprehensive** - searches workspace + mathlib
- ✅ **Structured** - returns name/kind/file

**When to use:**
- Checking if a declaration exists before hallucinating
- Finding project-specific lemmas
- Understanding what's available

**Parameters:**
- `query` (required): Search term (e.g., "add_zero", "StrictMono")
- `limit` (optional): Max results (default 10)

**Example:**
```
lean_local_search("add_zero", limit=5)
→ [{"name": "add_zero", "kind": "theorem", "file": "Init/Grind/Ring/Envelope.lean"},
   {"name": "add_zero", "kind": "theorem", "file": "Init/Grind/Module/Envelope.lean"}]
```

**Return structure:**
```json
[
  {
    "name": "declaration_name",
    "kind": "theorem" | "def" | "axiom" | "structure" | ...,
    "file": "relative/path/to/file.lean"
  },
  ...
]
```

**Pro tips:**
- Start with partial matches. Search "add" to see all addition-related lemmas.
- Results include both your project and mathlib
- Fast enough to search liberally

**Requirements:**
- ripgrep installed and in PATH
- macOS: `brew install ripgrep`
- Linux: `apt install ripgrep` or see https://github.com/BurntSushi/ripgrep#installation
- Windows: See https://github.com/BurntSushi/ripgrep#installation

**If not installed:** The tool will fail with an error. Install ripgrep to enable fast local search.

---

### `lean_multi_attempt` - Parallel Tactic Testing

**This is the most powerful workflow tool.** Test multiple tactics at once and see EXACTLY why each succeeds or fails.

**When to use:**
- A/B test 3-5 candidate tactics
- Understand why approaches fail (exact error messages)
- Compare clarity/directness
- Explore proof strategies

**Parameters:**
- `file_path` (required): Absolute path to Lean file
- `line` (required): Line number where tactic should go (1-indexed)
- `snippets` (required): Array of tactic strings to test

**Example 1: Choosing between working tactics**
```
lean_multi_attempt(file, line=13, snippets=[
  "  simp [Nat.add_comm]",
  "  omega",
  "  apply Nat.add_comm"
])

→ Output (v0.17+): Returns **structured goals** for each snippet:
[{"snippet": "  simp [Nat.add_comm]", "goals": []},  # no goals = success!
 {"snippet": "  omega", "goals": []},
 {"snippet": "  apply Nat.add_comm", "goals": []}]
```
All work! Pick simplest: `omega`

**Example 2: Learning from failures**
```
lean_multi_attempt(file, line=82, snippets=[
  "  exact Nat.lt_succ_self n",
  "  apply Nat.lt_succ_self",
  "  simp"
])

→ Output:
["  exact Nat.lt_succ_self n:\n Unknown identifier `n`",
 "  apply Nat.lt_succ_self:\n Could not unify...",
 "  simp:\n no goals\n\n"]
```
**Key insight:** Errors tell you WHY tactics fail - `n` out of scope, wrong unification, etc.

**Example 3: Multi-step tactics (single line)**
```
lean_multi_attempt(file, line=97, snippets=[
  "  intro i j hij; exact hij",
  "  intro i j; exact id",
  "  unfold StrictMono; simp"
])
```
Chain tactics with `;` - still single line!

**Critical constraints:**
- **Single-line snippets only** - no multi-line proofs
- **Must be fully indented** - `"  omega"` not `"omega"`
- **No comments** - avoid `--` in snippets
- **For testing only** - edit file properly after choosing

**Return structure:**
Array of strings, one per snippet:
```
["<snippet>:\n<goal_state_or_error>\n\n", ...]
```

Success: `"no goals"`
Failure: Error message explaining why

**Workflow:**
1. `lean_goal` to see what you need
2. Think of 3-5 candidate tactics
3. Test ALL with `lean_multi_attempt`
4. Pick winner, edit file
5. Verify with `lean_diagnostic_messages`

---

### `lean_hover_info` - Get Documentation

**When to use:**
- Unsure about function signature
- Need to see implicit arguments
- Want to check type of a term
- Debugging syntax errors

**Parameters:**
- `file_path` (required): Absolute path to Lean file
- `line` (required): Line number (1-indexed)
- `column` (required): Column number - must point to START of identifier (0-indexed)

**Example:**
```
lean_hover_info(file, line=20, column=30)
→ Shows definition, type, diagnostics at that location
```

**Return structure:**
```json
{
  "range": {"start": {"line": 20, "character": 30}, "end": {...}},
  "contents": "Type signature and documentation",
  "diagnostics": ["error messages if any"]
}
```

**Pro tips:**
- Use hover on error locations for detailed information about what went wrong
- Column must point to the first character of the identifier
- Returns both type information and any errors at that location

---

### `lean_file_outline` - File Structure Overview

**When to use:**
- Getting a quick overview of a Lean file
- Finding theorem/definition locations
- Understanding file structure without reading entire file

**Parameters:**
- `file_path` (required): Absolute path to Lean file

**Example:**
```
lean_file_outline("/path/to/MyFile.lean")
→ Returns:
- Imports: [Mathlib.Data.Real.Basic, ...]
- Declarations:
  - theorem add_comm (line 12): ∀ a b : ℕ, a + b = b + a
  - def myFunction (line 25): ℕ → ℕ → ℕ
  - structure MyStruct (line 40): ...
```

**Return structure:**
```json
{
  "imports": ["import1", "import2", ...],
  "declarations": [
    {"name": "decl_name", "kind": "theorem|def|structure|class", "line": 12, "type": "..."},
    ...
  ]
}
```

**Pro tips:**
- Faster than reading the file when you only need structure
- Use to find line numbers for `lean_goal` or `lean_multi_attempt`
- Good first step when exploring unfamiliar files

---

### `lean_run_code` - Run Standalone Snippets

**When to use:**
- Testing small code snippets without a full project
- Running `#eval` expressions
- Quick experimentation outside of proof context

**Parameters:**
- `code` (required): Lean code to run (string)

**Example:**
```
lean_run_code("#eval 5 * 7 + 3")
→ Output:
l1c1-l1c6, severity: 3
38
```

**What the output means:**
- `l1c1-l1c6`: Location (line 1, columns 1-6)
- `severity: 3`: Info message (not error)
- `38`: The computed result

**Severity levels:**
- 1 = Error
- 2 = Warning
- 3 = Info (normal output)

**Pro tips:**
- Use for quick `#check`, `#eval`, `#print` experiments
- Useful for testing mathlib imports without modifying files
- Each call runs in isolation - no persistent state

---

## External Search Tools (Rate-Limited)

**Use these when `lean_local_search` doesn't find what you need.**

These tools call external APIs (loogle.lean-lang.org, leansearch.net). The **LSP server rate-limits all external tools to 3 requests per 30 seconds** to avoid overwhelming the services.

**Why rate-limited:** These tools make HTTP requests to external services, not your local Lean project. The LSP server manages the rate limiting automatically.

---

### `lean_loogle` - Type Pattern Search

**Best for:** You know input/output types but not the name

**When to use:**
- Have a type pattern: `(α → β) → List α → List β`
- Know the structure but not the lemma name
- Search by type shape

**Parameters:**
- `query` (required): Type pattern string
- `num_results` (optional): Max results (default 6)

**Tip (v0.16+):** You can run Loogle locally to avoid the 3 req/30s rate limit. First run takes 5-10 min to build the index; subsequent runs start in seconds. See lean-lsp-mcp docs for setup.

**Example:**
```
lean_loogle("(?a -> ?b) -> List ?a -> List ?b", num_results=5)
→ Returns: List.map, List.mapIdx
```

**Type pattern syntax:**
- `?a`, `?b`, `?c` - Type variables
- `_` - Wildcards
- `->` or `→` - Function arrow
- `|- pattern` - Search by conclusion

**Most useful patterns:**
- By type shape: `(?a -> ?b) -> List ?a -> List ?b` ✅
- By constant: `Real.sin`
- By subexpression: `_ * (_ ^ _)`
- By conclusion: `|- _ + 0 = _`

**IMPORTANT:** Loogle searches by *type structure*, not names.
- ❌ `"Measure.map"` - no results (searching by name)
- ✅ `"Measure ?X -> (?X -> ?Y) -> Measure ?Y"` - finds Measure.map

**Decision tree:**
```
Know exact name? → lean_local_search
Know concept/description? → lean_leansearch
Know input/output types? → lean_loogle ✅
```

**Return structure:**
```json
[
  {
    "name": "List.map",
    "type": "(α → β) → List α → List β",
    "module": "Init.Data.List.Basic",
    "doc": "Map a function over a list"
  },
  ...
]
```

**Pro tips:**
- Use `?` for type variables you want to unify
- Use `_` for parts you don't care about
- Start general, then refine if too many results

---

### `lean_leansearch` - Natural Language Search

**Best for:** Conceptual/description-based search

**When to use:**
- You have a concept: "Cauchy Schwarz inequality"
- Natural language description of what you need
- Don't know exact type or name

**Parameters:**
- `query` (required): Natural language or Lean identifier
- `num_results` (optional): Max results (default 6)

**Query patterns:**
- Natural language: "Cauchy Schwarz inequality"
- Mixed: "natural numbers. from: n < m, to: n + 1 < m + 1"
- Lean identifiers: "List.sum", "Finset induction"
- Descriptions: "if a list is empty then its length is zero"

**Example:**
```
lean_leansearch("Cauchy Schwarz inequality", num_results=5)
→ Returns theorems related to Cauchy-Schwarz
```

**Return structure:**
```json
[
  {
    "name": "inner_mul_le_norm_mul_norm",
    "type": "⟪x, y⟫ ≤ ‖x‖ * ‖y‖",
    "module": "Analysis.InnerProductSpace.Basic",
    "docString": "Cauchy-Schwarz inequality",
    "relevance": 0.95
  },
  ...
]
```

**Pro tips:**
- Be descriptive but concise
- Include key mathematical terms
- Can mix natural language with Lean syntax
- Results ranked by relevance

---

### `lean_leanfinder` - Semantic Search for Mathlib

**Best for:** Semantic search with natural language, goal states, or informal descriptions

**What makes it special:**
- **Tuned for mathematician queries:** Works with informal descriptions, partial statements, natural language questions
- **Goal-aware:** Paste proof states (⊢ ...) directly - it understands them
- **>30% improvement:** Over prior search engines on retrieval tasks (arXiv evaluation)
- **Returns paired results:** Formal snippet + informal summary

**When to use:**
- **Searching Mathlib:** Best first choice for semantic search across Mathlib
- **You have a goal:** Paste proof states (⊢ ...) directly for goal-aware search
- **Math questions:** "Does y being a root of minpoly(x) imply minpoly(x)=minpoly(y)?"
- **Informal descriptions:** "algebraic elements with same minimal polynomial"
- **Natural/fuzzy queries:** Use before `lean_loogle` when query is conceptual

**Rule of thumb:**
- Searching your own repo? → Try `lean_local_search` first (unlimited, instant)
- Searching Mathlib or have a goal? → Try `lean_leanfinder` first (semantic, goal-aware)

**Parameters:**
- `query` (required): Natural language, statement fragment, or goal text
  - Can paste Lean goal exactly as shown (e.g., beginning with ⊢)
  - No need to ASCII-escape Unicode (⊢, ‖z‖, etc.) - paste directly!
  - Can add short hints: "⊢ |re z| ≤ ‖z‖ + transform to squared norm inequality"

**Returns:**
```typescript
Array<[formal_snippet: string, informal_summary: string]>
```

Each result is a 2-element array:
1. Formal snippet (Lean theorem/lemma as formatted)
2. Informal summary of what it states

```json
[
  [
    "/-- If `y : L` is a root of `minpoly K x`, then `minpoly K y = minpoly K x`. -/\ntheorem ... : minpoly K y = minpoly K x := ...",
    "If y is a root of minpoly_K(x) and x is algebraic over K, then minpoly_K(y) = minpoly_K(x)."
  ],
  ...
]
```

**Effective query types** (proven on Putnam benchmark problems):

**1. Math + API** - Mix math terms with Lean identifiers:
```python
lean_leanfinder(query="setAverage Icc interval")
lean_leanfinder(query="integral_pow symmetric bounds")
```
Best for: When you know the math concept AND suspect which Lean API area it's in

**2. Conceptual** - Pure mathematical concepts:
```python
lean_leanfinder(query="algebraic elements same minimal polynomial")
lean_leanfinder(query="quadrature nodes")
```
Best for: Abstract math ideas without knowing Lean names

**3. Structure** - Mathlib structures with operations:
```python
lean_leanfinder(query="Finset expect sum commute")
lean_leanfinder(query="polynomial degree bounded eval")
```
Best for: Combining type names with operations/properties

**4. Natural** - Plain English statements:
```python
lean_leanfinder(query="average equals point values")
lean_leanfinder(query="root implies equal polynomials")
```
Best for: Translating informal math to formal theorems

**5. Goal-based** (recommended in proofs!):
```python
# Get current goal:
lean_goal(file_path="/path/to/file.lean", line=24)
# Output: ⊢ |re z| ≤ ‖z‖

# Use goal with optional hint:
lean_leanfinder(query="⊢ |re z| ≤ ‖z‖ + transform to squared norm")
```
Best for: Finding lemmas that directly help your current proof state

**6. Q&A style** - Direct questions:
```python
lean_leanfinder(query="Does y being a root of minpoly(x) imply minpoly(x)=minpoly(y)?")
```
Best for: Exploring if a mathematical property holds

**Key insight:** Mix informal math terms with Lean identifiers. **Multiple targeted queries beat one complex query.**

**Workflow pattern:**
1. `lean_goal` to get current goal
2. `lean_leanfinder` with goal text (+ optional hint)
3. For promising hits, open source: `lean_declaration_file(symbol="...")`
4. Test with `lean_multi_attempt`

**Pro tips:**
- **Multiple targeted queries beat one complex query** - break down your search
- Goal text works best - paste directly from `lean_goal` output
- Mix informal math with Lean API terms (e.g., "setAverage Icc interval")
- Add 3-6 word hints for direction ("rewrite with minpoly equality")
- Try different query types if first attempt yields weak results
- Always verify hits with `lean_multi_attempt` before committing

**⚠️ Common gotchas:**
- **Rate limits:** Unlike `lean_local_search` (unlimited), this tool is rate-limited to 3 req/30s shared with other external tools
- **Partial snippets:** Returned snippets may be partial or need adaptation - always verify with `lean_multi_attempt` before committing
- **Over-hinting:** Sometimes less is more - Lean Finder can often infer intent from goal alone without extra hints
- **Not checking local first:** For project-specific declarations, `lean_local_search` is faster and unlimited

**Rate limiting:**
- **Shared 3 req/30s limit** with all external tools (`lean_loogle`, `lean_leansearch`, `lean_state_search`)
- **Unlike `lean_local_search`** which is unlimited and instant
- If rate-limited: Wait 30 seconds or use `lean_local_search` for local declarations

**Troubleshooting:**
- **Empty/weak results:** Rephrase in plain English, include goal line with ⊢, add 3-6 word direction
- **Latency:** Queries external service; brief delays possible. Use `lean_local_search` for strictly local behavior
- **Verification:** Always check returned snippets with `lean_declaration_file` and test with `lean_multi_attempt`
- **Rate limit exceeded:** Wait 30 seconds, or search locally with `lean_local_search` instead

**References:**
- Paper: [Lean Finder on arXiv](https://arxiv.org/pdf/2510.15940)
- Public UI: [Lean Finder on Hugging Face](https://huggingface.co/spaces/delta-lab-ai/Lean-Finder)
- Implementation: lean-lsp-mcp server (feature/lean-finder-support branch)

---

### `lean_state_search` - Proof State Search

**Best for:** Finding lemmas that apply to your current proof state

**Use when stuck on a specific goal.**

**When to use:**
- You're stuck at a specific proof state
- Want to see what lemmas apply
- Looking for similar proofs

**Parameters:**
- `file_path` (required): Absolute path to Lean file
- `line` (required): Line number (1-indexed)
- `column` (required): Column number (0-indexed)
- `num_results` (optional): Max results (default 6)

**Example:**
```
lean_state_search(file, line=42, column=2, num_results=5)
→ Returns lemmas that might apply to the goal at that location
```

**How it works:**
1. Extracts the proof state (goal) at the given location
2. Searches for similar goals in mathlib proofs
3. Returns lemmas that were used in similar situations

**Return structure:**
```json
[
  {
    "name": "lemma_name",
    "state": "Similar goal state",
    "nextTactic": "Tactic used in mathlib",
    "relevance": 0.88
  },
  ...
]
```

**Pro tips:**
- Point to the tactic line, not the lemma line
- Works best with canonical goal shapes
- Shows what tactics succeeded in similar proofs
- Particularly useful when standard searches don't help

---

## Rate Limit Management

**External tools share a rate limit:** 3 requests per 30 seconds total (not per tool).

**The LSP server handles this automatically:**
- Tracks requests across all external tools
- Returns error if rate limit exceeded
- Resets counter every 30 seconds

**If you hit the limit:**
```
Error: Rate limit exceeded. Try again in X seconds.
```

**Best practices:**
1. Always use `lean_local_search` first (unlimited!)
2. Batch your external searches - think about what you need before calling
3. If multiple searches needed, prioritize by likelihood
4. Wait 30 seconds before retrying if rate-limited

**Priority order:**
1. `lean_local_search` - Always first, unlimited
2. `lean_loogle` - When you have type patterns
3. `lean_leansearch` - When you have descriptions
4. `lean_state_search` - When really stuck

---

## Advanced Tips

### Combining Tools

**Pattern: Search → Test → Apply**
```
1. lean_goal(file, line)           # What to prove?
2. lean_local_search("keyword")    # Find candidates
3. lean_multi_attempt([            # Test them all
     "  apply candidate1",
     "  exact candidate2",
     "  simp [candidate3]"
   ])
4. [Edit with winner]
5. lean_diagnostic_messages(file)  # Confirm
```

### Which Search Tool to Use?

**Two-path rule:**
```
PATH 1: Searching your own repo
  → lean_local_search("name")        # Superpower: Unlimited, instant

PATH 2: Searching Mathlib / have a goal
  → lean_leanfinder("goal or query") # Superpower: Semantic, goal-aware
```

**Detailed decision tree:**
```
Searching own project/workspace?
  → lean_local_search("name")        # Unlimited, instant, comprehensive

Have goal state (⊢ ...)?
  → lean_leanfinder("⊢ ... + hint")  # Superpower: Goal-aware semantic search
  → lean_state_search(file, line)    # Alternative: Goal-conditioned premises

Searching Mathlib with informal query?
  → lean_leanfinder("description")   # Superpower: >30% better semantic search
  → lean_leansearch("description")   # Alternative: Natural language

Know exact type pattern?
  → lean_loogle("?a -> ?b")          # Superpower: Type structure matching

Know exact/partial name?
  → lean_local_search("name")        # Try local first (unlimited!)
  → If not found → lean_leanfinder("name") or lean_leansearch("name")
```

**Full escalation path:**
```
1. lean_local_search("exact_name")    # Local first (unlimited)
2. lean_local_search("partial")       # Try partial match
3. lean_leanfinder("goal or query")   # Semantic search (>30% improvement!)
4. lean_loogle("?a -> ?b")            # Type pattern if known
5. lean_leansearch("description")     # Natural language (alternative)
6. lean_state_search(file, line, col) # Goal-conditioned (when really stuck)
```

### Debugging Multi-Step Proofs

**Check goals between every tactic:**
```
lemma foo : P := by
  tactic1  -- Check with lean_goal
  tactic2  -- Check with lean_goal
  tactic3  -- Check with lean_goal
```

See exactly what each tactic accomplishes!

### Understanding Failures

**Use `lean_multi_attempt` to diagnose:**
```
lean_multi_attempt(file, line, [
  "  exact h",           # "Unknown identifier h"
  "  apply theorem",     # "Could not unify..."
  "  simp"               # Works!
])
```

Errors tell you exactly why tactics fail - invaluable for learning!

---

## Common Patterns

### Pattern 1: Finding and Testing Lemmas
```
lean_local_search("add_comm")
→ Found candidates

lean_multi_attempt(file, line, [
  "  apply Nat.add_comm",
  "  simp [Nat.add_comm]",
  "  omega"
])
→ Test which approach works best
```

### Pattern 2: Goal-Based Semantic Search
```python
# Get current goal:
lean_goal(file_path="/path/to/file.lean", line=42)
# → Output: ⊢ |re z| ≤ ‖z‖

# Search with goal + hint:
lean_leanfinder(query="⊢ |re z| ≤ ‖z‖ + transform to squared norm")
# → Returns: [[formal_snippet1, informal_summary1], [formal_snippet2, ...], ...]

# Test candidates:
lean_multi_attempt(
    file_path="/path/to/file.lean",
    line=43,
    snippets=[
        "  apply lemma_from_result1",
        "  rw [lemma_from_result2]"
    ]
)
# → Shows which tactics work
```

### Pattern 3: Stuck on Unknown Type
```
lean_hover_info(file, line, col)
→ See what the type actually is

lean_loogle("?a -> ?b matching that type")
→ Find lemmas with that type signature
```

### Pattern 4: Multi-Step Proof
```
For each step:
  lean_goal(file, line)           # See current goal
  lean_local_search("keyword")    # Find lemma
  lean_multi_attempt([tactics])   # Test
  [Edit file]
  lean_diagnostic_messages(file)  # Verify
```

Repeat until "no goals"!

### Pattern 5: Refactoring Long Proofs

Use `lean_goal` to survey proof state and find natural subdivision points:

```python
# Survey long proof to find extraction points
lean_goal(file, line=15)   # After setup
lean_goal(file, line=45)   # After first major step
lean_goal(file, line=78)   # After second major step

# Extract where goals are clean and self-contained
# Full workflow in proof-refactoring.md
```

**See:** [proof-refactoring.md](proof-refactoring.md) for complete refactoring workflow with LSP tools.

---

## Performance Notes

**Local tools (instant):**
- `lean_goal`: < 100ms typically
- `lean_local_search`: < 500ms with ripgrep
- `lean_multi_attempt`: < 1s for 3-5 snippets
- `lean_diagnostic_messages`: < 100ms
- `lean_hover_info`: < 100ms

**External tools (variable):**
- `lean_loogle`: 500ms-2s (type search is fast)
- `lean_leansearch`: 2-5s (semantic search is slower)
- `lean_state_search`: 1-3s (moderate complexity)

**Total workflow:** < 10 seconds for complete proof iteration (vs 30+ seconds with build)

---

## See Also

- [lean-lsp-server.md](lean-lsp-server.md) - Quick reference and workflow patterns
- [mathlib-guide.md](mathlib-guide.md) - Finding and using mathlib lemmas
- [tactics-reference.md](tactics-reference.md) - Lean tactic documentation
