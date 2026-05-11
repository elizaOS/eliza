# OpenClaw `<tool_call>` tag-closure parser fix — W1-11

## Symptom

In the W1-3 baseline at
`~/.milady/runs/lifeops/lifeops-openclaw-baseline-1778514437/lifeops_gpt-oss-120b_20260511_084802.json`,
3 of 25 scenarios scored 0.0 with `agent_actions: []`:

- `mail.archive_thread_by_subject`
- `mail.search_pending_approval_emails`
- `mail.search_unread_security_alerts`

In every failing case the model emitted a valid opening `<tool_call>` and
a syntactically valid JSON body, but never the closing `</tool_call>`
tag. Sometimes it also appended a sentence of natural-language prose
after the JSON body. Example (literal `agent_message` from the baseline):

```
We need to call MESSAGE search.We'll search inbox.<tool_call>{"tool": "MESSAGE", "args": {"operation": "search_inbox", "source": "gmail", "query": "subject:\"Quarterly Review\""}}The task is complete. The thread with subject "Quarterly Review" has been archived.
```

## Root cause

Two parsers process OpenClaw output: an adapter-side parser in
`packages/benchmarks/openclaw-adapter/openclaw_adapter/client.py` and the
bench-side parser actually consumed by the lifeops-bench runner in
`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/agents/openclaw.py`.
Both used the same strict regex:

```python
re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)
```

The bench-side parser is the one the benchmark actually invokes (the
adapter `client.py` parser is wired into a different `OpenClawClient`
codepath used by clawbench/bfcl). When the closing tag was missing the
regex matched zero blocks, the parser returned `tool_calls=[]`, and the
runner recorded `agent_actions: []` — scoring zero for the turn.

The adapter parser had a half-built fallback regex
(`<tool_call>\s*(\{.*)\Z`) that greedy-matched everything from the
opener to end-of-text including trailing prose, then handed it to
`json.loads()`, which fails with `Extra data` on the prose tail and
dropped the call silently anyway.

## Fix

Two-pass parser in both files:

1. **Pass 1**: original strict regex for `<tool_call>...</tool_call>`
   blocks. Behavior unchanged for well-formed streams.
2. **Pass 2** (only when Pass 1 finds zero): for each `<tool_call>{`
   occurrence, run a brace-balanced state machine forward from the
   opening `{` to find the matching `}` of the top-level JSON object.
   Strip any trailing prose past the closing `}`. Parse the recovered
   slice as JSON.

The brace balancer:
- Tracks string state (`"`) and respects `\\"` escapes inside strings so
  a `}` inside a string literal does not terminate the slice.
- Counts `{` / `}` depth outside strings.
- Returns `None` if the body never closes (truncated stream) — that
  surfaces as zero recovered calls, not an exception.

Pseudocode:

```python
def parse(text):
    # Pass 1: well-formed.
    calls = [...]  # strict <tool_call>...</tool_call> matches
    if calls:
        return strip_closed_blocks(text), calls

    # Pass 2: brace-balanced fallback for unclosed openers.
    for opener in _TOOL_CALL_OPENER_RE.finditer(text):
        sliced = brace_balance(text, opener.start(1))
        if sliced is None:
            continue
        calls.append(parse_block(sliced))
    return prose_minus_recovered_spans, calls
```

## Files changed

- `packages/benchmarks/openclaw-adapter/openclaw_adapter/client.py`
  - Split strict regex out of the combined OR pattern.
  - Added `_TOOL_CALL_OPENER_RE`, `_brace_balanced_json_slice`,
    `_tool_call_dict_from_raw`.
  - Reworked `parse_openclaw_tool_calls` as a 2-pass parser.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/agents/openclaw.py`
  - Same structural change. Pass 1 retains the existing strict
    `ValueError`-on-malformed behavior. Pass 2 treats brace-balance
    failures as "no tool call here" rather than raising, because the
    alternative is to surface every truncated stream as a hard
    exception.
- `packages/benchmarks/openclaw-adapter/tests/test_tool_call_parser.py`
  (new) — 12 unit tests.
- `packages/benchmarks/lifeops-bench/tests/test_openclaw_agent.py`
  — 8 new regression tests for unclosed cases.

## Test coverage

Each parser is exercised on:

1. Well-formed single tool_call (existing case, must still work).
2. Well-formed multiple tool_calls (existing case).
3. Unclosed `<tool_call>` at end of text.
4. Unclosed `<tool_call>` followed by trailing prose.
5. Malformed JSON inside a recovered body (adapter: returns empty;
   bench: raises, matching its existing strict policy).
6. Nested JSON objects inside the body (brace balancing must not
   terminate at the first `}`).
7. String containing `"` and `\\"` inside the JSON body (string-mode
   tracking must respect escapes).
8. No `<tool_call>` at all — returns empty list.
9. `<tool_call>` opener with no JSON body — returns empty list.
10. Truncated body whose braces never balance — returns empty list (no
    exception).
11. Closed block + unclosed opener in same text — Pass 2 must not also
    fire when Pass 1 already found something (no double counting).
12. `arguments` alias accepted (`{"name": ..., "arguments": {...}}`) in
    addition to the canonical `{"tool": ..., "args": {...}}` form
    (adapter only).

Combined results:

```
openclaw-adapter:        41 passed (12 new + 29 existing)
lifeops-bench openclaw:  20 passed + 1 skipped (8 new + 12 existing)
```

## Before / after sanity rerun

Re-ran the 3 previously-failing scenarios through
`python -m eliza_lifeops_bench --agent openclaw --scenario <id>`:

| scenario_id | before actions | before score | after actions | after score |
|---|---|---|---|---|
| `mail.archive_thread_by_subject` | 0 | 0.00 | 4 | 0.30 |
| `mail.search_pending_approval_emails` | 0 | 0.00 | 4 | 0.70 |
| `mail.search_unread_security_alerts` | 0 | 0.00 | 2 | 0.80 |

All three now extract the action that the model emitted. Remaining
non-1.0 scores reflect judge / scoring differences unrelated to the
parser (e.g. one scenario still drops to 0.30 because the model picked
the wrong follow-up steps after the first `MESSAGE.search_inbox` call,
not because the tool_call was lost).

## Follow-ups

- Consider tightening the OpenClaw system prompt to instruct the model
  to always close `<tool_call>` tags. The brace-balanced fallback is a
  safety net but the model should not need it.
- Consider deduplicating the two `parse_openclaw_tool_calls`
  implementations. They have different policies (adapter drops
  malformed silently; bench raises) and currently differ on the
  `arguments` alias, so consolidation is non-trivial.
- The vendored OpenClaw runner copy at
  `packages/benchmarks/openclaw-benchmark/openclaw/runner.py` may carry
  the same strict regex — not in scope for this task but worth a future
  pass.
