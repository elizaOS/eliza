# Lean LSP Server - Quick Reference

**The Lean LSP server provides instant feedback for interactive theorem development.**

**Key insight:** LSP tools provide instant feedback (< 1 second) versus build cycles (10-30+ seconds). This **30x speedup** transforms proof development from frustrating trial-and-error into smooth, interactive problem-solving.

---

## Prerequisites

**Before using LSP tools:**

1. **Run `lake build` first** - The LSP server runs `lake serve` which can timeout during initial project build. Run `lake build` manually in your project directory before starting the MCP server to ensure fast startup and avoid timeouts.

2. **Install ripgrep** - Required for `lean_local_search` (the most-used search tool):
   - macOS: `brew install ripgrep`
   - Linux: `apt install ripgrep` or https://github.com/BurntSushi/ripgrep#installation
   - Windows: https://github.com/BurntSushi/ripgrep#installation
   - Verify: `rg --version` should work

**Without these:** You may experience server timeouts or missing search functionality.

---

## The Workflow Pattern

**Every proof follows this pattern:**

```
1. lean_goal(file, line)                    # What to prove?
2. lean_local_search("keyword", limit=10)   # Does it exist?
3. lean_multi_attempt(file, line, [         # Test tactics
     "  simp", "  omega", "  apply lemma"
   ])
4. [Edit file with winner]
5. lean_diagnostic_messages(file)           # Verify
6. lean_goal(file, line)                    # Confirm "no goals"
```

**Total time:** < 10 seconds (LSP) vs 30+ seconds per iteration (build-only)

**Measured improvements:**
- Feedback: **30x faster** (< 1s vs 30s)
- Tactic exploration: **4x fewer iterations** (parallel testing)
- Lemma discovery: **10x faster** (integrated search)

---

## Critical Rules

1. **NEVER edit without checking goal state first** (`lean_goal`)
2. **ALWAYS check diagnostics after edits** (don't wait for build)
3. **Search before guessing** - use `lean_local_search` FIRST (fast & unlimited!)
4. **Check goals between tactics** - see intermediate progress
5. **Use `lean_multi_attempt` liberally** - test multiple tactics at once
6. **Respect rate limits** - `lean_local_search` is unlimited, others are 3 req/30s
7. **NEVER use `lean_file_contents` on large files** - wastes tokens, use `Read` tool instead (see warning below)

---

## Tool Summary

**Local tools (unlimited, instant):**
- Direct LSP queries against your project files
- No rate limits, < 1 second response time

**External tools (rate-limited to 3 req/30s):**
- Remote API calls to loogle.lean-lang.org, leansearch.net, Lean Finder service
- Managed by LSP server to avoid overwhelming services

**Best practice:** Always use local tools first (especially `lean_local_search`), then external tools only when local search doesn't find what you need.

| Tool | Type | Rate Limit | Speed | Use For |
|------|------|------------|-------|---------|
| `lean_goal` | **Local** | None | Instant | See goals (always!) |
| `lean_local_search` | **Local** | None | Instant | Find lemmas (use first!) |
| `lean_multi_attempt` | **Local** | None | Instant | Test tactics in parallel |
| `lean_diagnostic_messages` | **Local** | None | Instant | Check errors |
| `lean_hover_info` | **Local** | None | Instant | Check syntax/types |
| `lean_file_outline` | **Local** | None | Fast | File structure overview |
| `lean_run_code` | **Local** | None | Fast | Run standalone snippets |
| `lean_file_contents` | **Local** | None | Fast | Read files ⚠️ See warning below |
| `lean_loogle` | **External** | 3/30s | Fast | Type patterns |
| `lean_leansearch` | **External** | 3/30s | Slower | Natural language |
| `lean_leanfinder` | **External** | 3/30s | Fast | Semantic search (best for goals!) |
| `lean_state_search` | **External** | 3/30s | Fast | Proof state |

**See [lean-lsp-tools-api.md](lean-lsp-tools-api.md) for detailed API documentation.**

---

## ⚠️ Important: Avoid `lean_file_contents` on Large Files

**DO NOT use `lean_file_contents` directly on large files** - it wastes tokens and will error if file exceeds 25000 tokens:

```
Error: MCP tool "lean_file_contents" response (36863 tokens) exceeds
maximum allowed tokens (25000). Please use pagination, filtering, or
limit parameters to reduce the response size.
```

**Instead, use:**
- **`Read` tool** (Claude Code built-in) - optimized for large files, supports offset/limit
- **`lean_goal`** - for specific line's proof state (< 1% of file size)
- **`lean_hover_info`** - for specific term's type
- **`lean_diagnostic_messages`** - for errors only
- **`lean_local_search`** - to find specific definitions without reading entire file

**Why:** `lean_file_contents` loads the entire file with annotations, consuming tokens proportional to file size. Most proof development tasks only need targeted information (goals, errors, specific definitions), not the whole file.

**Rule of thumb:** If you need to read a file, use `Read` tool. Only use `lean_file_contents` on small files (<100 lines) when you specifically need LSP annotations.

---

## Common Usage Patterns

### When stuck on a proof
```
1. lean_goal(file, line)              # See exact state
2. lean_leanfinder("⊢ ... + hint")    # Semantic search (paste goal!)
3. lean_loogle("pattern")             # Type pattern search
4. lean_leansearch("description")     # Natural language search
5. lean_state_search(file, line, col) # Proof state search
```

### Emergency debugging
```
1. lean_diagnostic_messages(file)     # What errors?
2. lean_hover_info(file, line, col)   # What's the type?
3. lean_goal(file, line)              # What are goals?
```

### Testing multiple approaches
```
lean_multi_attempt(file, line, [
  "  simp [lemma1]",
  "  omega",
  "  apply lemma2"
])
```
See which works, pick the best one!

---

## Complete Example: End-to-End Proof

**Task:** Prove `n + m = m + n`

```lean
lemma test_add_comm (n m : ℕ) : n + m = m + n := by
  sorry
```

### Step 1: Check goal (ALWAYS FIRST!)
```
lean_goal(file, line=12)
→ Output:
After:
n m : ℕ
⊢ n + m = m + n
```
**Now you know exactly what to prove!**

### Step 2: Search for lemmas
```
lean_local_search("add_comm", limit=5)
→ [{"name": "add_comm", "kind": "theorem", ...}]
```
**Found it! But let's test multiple approaches...**

### Step 3: Test tactics in parallel
```
lean_multi_attempt(file, line=13, snippets=[
  "  simp [Nat.add_comm]",
  "  omega",
  "  apply Nat.add_comm"
])
→ All three show "no goals" ✅
```
**Pick simplest: `omega`**

### Step 4: Edit file
```lean
lemma test_add_comm (n m : ℕ) : n + m = m + n := by
  omega
```

### Step 5: Verify immediately
```
lean_diagnostic_messages(file)
→ []  ← No errors!
```

### Step 6: Confirm completion
```
lean_goal(file, line=13)
→ After:
no goals
```
**SUCCESS! 🎉**

**Total time:** < 10 seconds with absolute certainty

**Build-only would take:** 30+ seconds per try-and-rebuild cycle

---

## Common Mistakes to Avoid

❌ **DON'T:**
- Edit → build → see error (too slow!)
- Guess lemma names without searching
- Apply tactics blind without checking goal
- Use rate-limited search when `lean_local_search` works
- Skip intermediate goal checks in multi-step proofs

✅ **DO:**
- Check goal → search (local first!) → test → apply → verify
- Use `lean_multi_attempt` to explore tactics
- Verify with `lean_diagnostic_messages` after every edit
- Check intermediate goals after each tactic
- Respect rate limits

---

## Troubleshooting

### "Unknown identifier" errors
**Problem:** `add_comm` not found

**Solutions:**
1. Try qualified name: `Nat.add_comm`
2. Use `lean_local_search` to find correct name
3. Try tactic instead: `omega` or `simp`

### "Function expected" with type classes
**Problem:** `StrictMono Nat.succ` fails

**Solution:** Add type annotation: `StrictMono (Nat.succ : ℕ → ℕ)`

### Search finds nothing
**Problem:** `lean_local_search` returns empty

**Solutions:**
1. Try partial matches: `"add"` instead of `"add_zero"`
2. Use wildcards in loogle: `"_ + 0"`
3. Try natural language: `lean_leansearch("addition with zero")`

### Multi-attempt shows all failures
**Check:**
1. Proper indentation? Include leading spaces
2. Correct line number? Point to tactic line
3. Single-line only? Multi-line not supported

### Empty diagnostics but proof incomplete
**Problem:** `[]` diagnostics but not done

**Solution:** Check `lean_goal` - if goals remain, need more tactics

**Key insight:** Empty diagnostics = no errors, but proof may be incomplete. Always verify goals.

---

## Why This Matters

**Without LSP:** You're coding blind, relying on slow build cycles for feedback.

**With LSP:** You have the same interactive feedback loop as a human using Lean InfoView.

**The transformation:** From "guess and wait" to "see and verify" instantly.

**Measured results:**
- **30x faster feedback** (< 1s vs 30s)
- **4x fewer iterations** (parallel testing)
- **10x faster discovery** (integrated search)

**Bottom line:** LSP tools fundamentally change how you develop proofs. Once you experience instant feedback, you'll never want to wait for builds again.
