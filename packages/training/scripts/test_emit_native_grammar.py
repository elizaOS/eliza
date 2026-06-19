"""Tests for `emit_native_grammar.py`.

Two things matter:

  1. The emitted GBNF is well-formed (parses with our minimal matcher) and
     accepts the *exact* `eliza_native_v1` planner envelopes that
     `native_record.py` produces — i.e. the grammar and the training-row
     format are byte-aligned (compact JSON, fixed key order, optional
     `messageToUser`, possibly-empty `toolCalls`).
  2. The grammar rejects an envelope whose `toolCalls[].name` is not in the
     exposed-action enum, and (with `--with-args`) rejects an arg key not in
     the action's schema.

The matcher below understands exactly the GBNF subset `emit_native_grammar.py`
emits: string literals with C-escapes (incl. the empty literal `""`), char
classes `[...]` (with ranges and `\\t`/`\\n`/`\\r`/`\\\\` escapes), `.`,
alternation `|`, grouping `( )`, postfix `*` and `?`, and rule references. It
is intentionally tiny — it is a format-alignment check, not a full GBNF impl.
"""

from __future__ import annotations

import json
import re

from scripts.emit_native_grammar import build_native_envelope_gbnf
from scripts.lib.native_record import native_tool_call_record


# ---------------------------------------------------------------------------
# Minimal GBNF matcher (recognizes the subset emit_native_grammar.py emits)
# ---------------------------------------------------------------------------


def _parse_gbnf(text: str) -> dict[str, list]:
    """Parse GBNF into {rule_name: alternation-AST}. AST nodes:
      ("lit", str) | ("class", matcher_fn) | ("dot",) | ("ref", name)
      ("seq", [items]) | ("alt", [seqs]) | ("star", node) | ("opt", node)
    """
    rules: dict[str, list] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or "::=" not in line:
            continue
        name, body = line.split("::=", 1)
        rules[name.strip()] = _parse_alt(body.strip())[0]
    return rules


def _parse_alt(s: str, i: int = 0):
    seqs = []
    seq, i = _parse_seq(s, i)
    seqs.append(seq)
    while i < len(s):
        i = _skip_ws(s, i)
        if i < len(s) and s[i] == "|":
            i += 1
            seq, i = _parse_seq(s, i)
            seqs.append(seq)
        else:
            break
    return ("alt", seqs), i


def _parse_seq(s: str, i: int):
    items = []
    while i < len(s):
        i = _skip_ws(s, i)
        if i >= len(s) or s[i] in "|)":
            break
        node, i = _parse_atom(s, i)
        i = _skip_ws_inline(s, i)
        while i < len(s) and s[i] in "*?+":
            if s[i] == "*":
                node = ("star", node)
            elif s[i] == "?":
                node = ("opt", node)
            else:  # "+"  ->  node node*
                node = ("seq", [node, ("star", node)])
            i += 1
        items.append(node)
    return ("seq", items), i


def _parse_atom(s: str, i: int):
    i = _skip_ws(s, i)
    ch = s[i]
    if ch == "(":
        node, i = _parse_alt(s, i + 1)
        i = _skip_ws(s, i)
        assert s[i] == ")", f"expected ) at {i}: {s[i:i+20]!r}"
        return node, i + 1
    if ch == '"':
        return _parse_string_lit(s, i)
    if ch == "[":
        return _parse_class(s, i)
    if ch == ".":
        return ("dot",), i + 1
    # rule reference
    m = re.match(r"[A-Za-z_][A-Za-z0-9_-]*", s[i:])
    assert m, f"unexpected token at {i}: {s[i:i+20]!r}"
    return ("ref", m.group(0)), i + m.end()


_C_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", '"': '"', "'": "'"}


def _parse_string_lit(s: str, i: int):
    assert s[i] == '"'
    i += 1
    out = []
    while s[i] != '"':
        if s[i] == "\\":
            nxt = s[i + 1]
            if nxt == "x":
                out.append(chr(int(s[i + 2 : i + 4], 16)))
                i += 4
                continue
            out.append(_C_ESCAPES.get(nxt, nxt))
            i += 2
            continue
        out.append(s[i])
        i += 1
    return ("lit", "".join(out)), i + 1


def _parse_class(s: str, i: int):
    assert s[i] == "["
    i += 1
    negate = False
    if i < len(s) and s[i] == "^":
        negate = True
        i += 1
    chars: set[str] = set()
    ranges: list[tuple[str, str]] = []
    while s[i] != "]":
        if s[i] == "\\":
            nxt = s[i + 1]
            c = _C_ESCAPES.get(nxt, nxt)
            i += 2
        else:
            c = s[i]
            i += 1
        if i < len(s) and s[i] == "-" and i + 1 < len(s) and s[i + 1] != "]":
            i += 1
            if s[i] == "\\":
                hi = _C_ESCAPES.get(s[i + 1], s[i + 1])
                i += 2
            else:
                hi = s[i]
                i += 1
            ranges.append((c, hi))
        else:
            chars.add(c)

    def matcher(ch: str) -> bool:
        hit = ch in chars or any(lo <= ch <= hi for lo, hi in ranges)
        return (not hit) if negate else hit

    return ("class", matcher), i + 1


def _skip_ws(s: str, i: int) -> int:
    while i < len(s) and s[i] in " \t":
        i += 1
    return i


_skip_ws_inline = _skip_ws


# --- matching: returns set of end-indices reachable from `pos` ---------------


def _match(node, rules, text, pos, memo):
    key = (id(node), pos)
    if key in memo:
        return memo[key]
    kind = node[0]
    if kind == "lit":
        lit = node[1]
        res = {pos + len(lit)} if text.startswith(lit, pos) else set()
    elif kind == "dot":
        res = {pos + 1} if pos < len(text) else set()
    elif kind == "class":
        res = {pos + 1} if pos < len(text) and node[1](text[pos]) else set()
    elif kind == "ref":
        res = _match(rules[node[1]], rules, text, pos, memo)
    elif kind == "alt":
        res = set()
        for seq in node[1]:
            res |= _match(seq, rules, text, pos, memo)
    elif kind == "seq":
        cur = {pos}
        for item in node[1]:
            nxt: set[int] = set()
            for p in cur:
                nxt |= _match(item, rules, text, p, memo)
            cur = nxt
            if not cur:
                break
        res = cur
    elif kind == "opt":
        res = {pos} | _match(node[1], rules, text, pos, memo)
    elif kind == "star":
        res = {pos}
        frontier = {pos}
        while frontier:
            new: set[int] = set()
            for p in frontier:
                for q in _match(node[1], rules, text, p, memo):
                    if q not in res and q > p:
                        new.add(q)
            res |= new
            frontier = new
    else:
        raise AssertionError(f"bad node {node!r}")
    memo[key] = res
    return res


def gbnf_accepts(grammar: str, text: str) -> bool:
    rules = _parse_gbnf(grammar)
    assert "root" in rules, "grammar has no root rule"
    ends = _match(rules["root"], rules, text, 0, {})
    return len(text) in ends


# ---------------------------------------------------------------------------
# Fixtures: real eliza_native_v1 envelopes via native_record.py
# ---------------------------------------------------------------------------

ACTIONS = ["REPLY", "IGNORE", "STOP", "SEND_MESSAGE", "WEB_SEARCH", "TASK_CALL"]


def _envelope_text(thought, calls, message_to_user=None) -> str:
    rec = native_tool_call_record(
        system="sys",
        turns=[{"role": "user", "content": "hi"}],
        thought=thought,
        tool_calls=calls,
        message_to_user=message_to_user,
    )
    return rec["response"]["text"]


def test_grammar_accepts_native_envelopes() -> None:
    g = build_native_envelope_gbnf(ACTIONS)
    samples = [
        _envelope_text("nothing to do", [], message_to_user="hello there"),
        _envelope_text("need to search", [{"name": "WEB_SEARCH", "args": {"query": "weather sf"}}]),
        _envelope_text(
            "reply then stop",
            [
                {"name": "REPLY", "args": {"text": "done"}},
                {"name": "STOP", "args": {}},
            ],
        ),
        _envelope_text("ignore this", [{"name": "IGNORE", "args": {}}]),
        # nested / array arg values
        _envelope_text("task", [{"name": "TASK_CALL", "args": {"steps": [1, 2], "opts": {"a": True}}}]),
        # quotes / escapes inside thought + args
        _envelope_text('user said "hi"\nok', [{"name": "REPLY", "args": {"text": "a\"b\\c"}}]),
    ]
    for s in samples:
        # sanity: it is the compact JSON native_record emits
        assert ", " not in s and ": " not in s, f"sample is not compact: {s!r}"
        assert gbnf_accepts(g, s), f"grammar rejected a real native envelope:\n{s}"


def test_grammar_rejects_unknown_action_name() -> None:
    g = build_native_envelope_gbnf(ACTIONS)
    bad = _envelope_text("do a thing", [{"name": "DEFINITELY_NOT_AN_ACTION", "args": {}}])
    assert not gbnf_accepts(g, bad), "grammar accepted an action name outside the enum"


def test_grammar_rejects_non_compact_in_compact_mode() -> None:
    g = build_native_envelope_gbnf(ACTIONS)  # compact=True default
    spaced = '{"thought": "x", "toolCalls": []}'
    assert not gbnf_accepts(g, spaced), "compact-mode grammar accepted spaced JSON"


def test_with_args_constrains_arg_keys_and_enums() -> None:
    arg_specs = {
        "TASK_CALL": {"keys": {"name": {"required": True}, "params": {}}},
        "MUSIC": {"keys": {"action": {"enum": ["play", "pause"]}, "id": {}}},
        "REPLY": {"keys": {"text": {"required": True}}},
    }
    names = ["TASK_CALL", "MUSIC", "REPLY"]
    g = build_native_envelope_gbnf(names, arg_specs=arg_specs, with_args=True)
    ok = _envelope_text("call", [{"name": "MUSIC", "args": {"action": "play", "id": "abc"}}])
    assert gbnf_accepts(g, ok), f"with-args grammar rejected a valid envelope:\n{ok}"
    # arg key not in MUSIC's schema -> rejected (the union of per-action arg
    # rules still doesn't admit `volume` for any action here)
    bad_key = _envelope_text("call", [{"name": "MUSIC", "args": {"volume": "11"}}])
    assert not gbnf_accepts(g, bad_key), "with-args grammar accepted an unknown arg key"
    # enum violation -> rejected
    bad_enum = _envelope_text("call", [{"name": "MUSIC", "args": {"action": "shuffle"}}])
    assert not gbnf_accepts(g, bad_enum), "with-args grammar accepted an out-of-enum arg value"


def test_action_docs_parser_extracts_names(tmp_path) -> None:
    from scripts.emit_native_grammar import _from_action_docs_ts

    ts = tmp_path / "action-docs.ts"
    ts.write_text(
        'export const allActionsSpec = {\n'
        '  version: "1.0.0",\n'
        '  actions: [\n'
        '    { name: "REPLY", description: "reply", parameters: [ { name: "text", required: true, schema: { type: "string" } } ], examples: [] },\n'
        '    { name: "MUSIC_CONTROL", description: "music", parameters: [ { name: "action", required: true, enum: ["play","pause"], schema: { type: "string" } } ], exampleCalls: [] },\n'
        '  ],\n'
        '} as const;\n',
        encoding="utf-8",
    )
    names, specs = _from_action_docs_ts(ts, with_args=True)
    assert names == ["MUSIC_CONTROL", "REPLY"]
    assert "action" in specs.get("MUSIC_CONTROL", {}).get("keys", {})
    assert specs["MUSIC_CONTROL"]["keys"]["action"].get("enum") == ["play", "pause"]
    g = build_native_envelope_gbnf(names, arg_specs=specs, with_args=True)
    ok = _envelope_text("m", [{"name": "MUSIC_CONTROL", "args": {"action": "play"}}])
    assert gbnf_accepts(g, ok)


def test_catalog_json_parser(tmp_path) -> None:
    from scripts.emit_native_grammar import _from_catalog_json

    cat = tmp_path / "catalog.json"
    cat.write_text(
        json.dumps(
            {
                "core": [
                    {"name": "REPLY", "parameters": [{"name": "text", "required": True}]},
                    {"name": "STOP", "parameters": []},
                ]
            }
        ),
        encoding="utf-8",
    )
    names, specs = _from_catalog_json(cat, with_args=True)
    assert names == ["REPLY", "STOP"]
    assert "text" in specs.get("REPLY", {}).get("keys", {})
