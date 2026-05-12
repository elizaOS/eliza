"""Emit the canonical GBNF grammar for the `eliza_native_v1` planner envelope.

The eliza-1 local models are fine-tuned to emit, as `response.text`, the
planner envelope

    {"thought": "...",
     "toolCalls": [{"id": "call_0", "name": "<ACTION>", "args": { ... }}, ...],
     "messageToUser"?: "..."}

with compact JSON (no spaces after `,`/`:`), fixed key order, and `id` /
`name` / `args` per call. The set of available action names — and, optionally,
each action's argument keys / arg enums — is known at inference time. This
script turns that knowledge into a GBNF grammar that:

  - pins `toolCalls[].name` to the exact enum of available action names,
  - (with --with-args) pins each call's `args` keys to that action's schema
    and any enum-valued args to their enum,
  - leaves `thought`, free-form arg values, and `messageToUser` as JSON
    strings / values,
  - makes `messageToUser` optional and `toolCalls` a possibly-empty array.

It is the *reference* the harness/inference team should diff their local-path
planner grammar against (today `@elizaos/core`'s `buildPlannerActionGrammar`
constrains the `PLAN_ACTIONS` tool-args shape, which is the cloud/AI-SDK
contract, not the local model's `eliza_native_v1` envelope — see
`docs/training/schema-constrained-decoding.md`).

It also lets the training pipeline verify format alignment:
`test_emit_native_grammar.py` checks the emitted grammar accepts real
`response.text` envelopes from the corpus.

Action names (and arg specs) can come from:

  * --names A,B,C            explicit comma-separated list
  * --action-docs <path>     parse `name:` (and, with --with-args, `parameters`)
                             out of packages/core/src/generated/action-docs.ts
  * --catalog <path>         a JSON file: list of {name, parameters?} or
                             {actions:[...]} or {<plugin>:[...]} (the shape
                             `build_actions_catalog.py` writes)

Usage (from training/):
    uv run python scripts/emit_native_grammar.py --names REPLY,IGNORE,STOP
    uv run python scripts/emit_native_grammar.py \\
        --action-docs ../core/src/generated/action-docs.ts --with-args --out plan.gbnf
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# GBNF construction
# ---------------------------------------------------------------------------

# Shared rule bodies, inlined so the emitted grammar is self-contained. These
# mirror @elizaos/core's `response-grammar.ts` GBNF_RULE_BODIES so a diff
# against the harness grammar is meaningful.
_SHARED_RULES: dict[str, str] = {
    "ws": "[ \\t\\n\\r]*",
    "jsonstring": '"\\"" ( [^"\\\\] | "\\\\" . )* "\\""',
    "jsonnumber": '"-"? ( [0-9] | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?',
    "jsonbool": '"true" | "false"',
    "jsonvalue": 'jsonobject | jsonarray | jsonstring | jsonnumber | "true" | "false" | "null"',
    "jsonobject": '"{" ws ( jsonstring ws ":" ws jsonvalue ( ws "," ws jsonstring ws ":" ws jsonvalue )* )? ws "}"',
    "jsonarray": '"[" ws ( jsonvalue ( ws "," ws jsonvalue )* )? ws "]"',
}


def _gbnf_escape(text: str) -> str:
    """Escape a string for a GBNF double-quoted literal (C-style escapes)."""
    out: list[str] = []
    for ch in text:
        code = ord(ch)
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif code < 0x20:
            out.append(f"\\x{code:02x}")
        else:
            out.append(ch)
    return "".join(out)


def _lit(text: str) -> str:
    """GBNF literal token for the fixed string `text`."""
    return f'"{_gbnf_escape(text)}"'


def _json_str_lit(value: str) -> str:
    """GBNF literal token for the JSON-quoted form of `value` (i.e. `"value"`)."""
    return _lit(json.dumps(value, ensure_ascii=False))


class _GbnfBuilder:
    def __init__(self) -> None:
        self._rules: dict[str, str] = {}
        self._root: list[str] = []

    def root(self, parts: list[str]) -> "_GbnfBuilder":
        self._root = parts
        return self

    def rule(self, name: str, body: str) -> "_GbnfBuilder":
        # First definition wins (matches @elizaos/core's GbnfBuilder).
        self._rules.setdefault(name, body)
        return self

    def use_shared(self, name: str) -> "_GbnfBuilder":
        if name in self._rules:
            return self
        body = _SHARED_RULES.get(name)
        if body is None:
            return self
        self._rules[name] = body
        for candidate, cbody in _SHARED_RULES.items():
            if candidate == name:
                continue
            if re.search(rf"(^|[^A-Za-z0-9_-]){re.escape(candidate)}([^A-Za-z0-9_-]|$)", body):
                self.use_shared(candidate)
        return self

    def build(self) -> str:
        lines = [f"root ::= {' '.join(self._root)}"]
        for name, body in self._rules.items():
            lines.append(f"{name} ::= {body}")
        return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Envelope grammar
# ---------------------------------------------------------------------------


def build_native_envelope_gbnf(
    action_names: list[str],
    *,
    arg_specs: dict[str, dict[str, Any]] | None = None,
    with_args: bool = False,
    compact: bool = True,
) -> str:
    """Build the GBNF for the `eliza_native_v1` planner envelope.

    `action_names` is the exposed-action enum for `toolCalls[].name`.
    `arg_specs` (used iff `with_args`) maps action name → a small schema-ish
    dict `{"keys": {<key>: {"enum": [...]?, "required": bool?}}}` (extra keys
    ignored) — when present the call's `args` object is constrained to that
    action's keys and enums; otherwise `args` is a free JSON object.
    `compact=True` matches `native_record.py`'s `separators=(",",":")` — no
    whitespace allowed between tokens. `compact=False` permits insignificant
    whitespace (use only if the runtime serializer is non-compact).
    """
    names = sorted({n for n in action_names if n})
    if not names:
        raise ValueError("build_native_envelope_gbnf: need at least one action name")

    b = _GbnfBuilder()
    # `ows` ("optional whitespace") is the empty string in compact mode so the
    # grammar is byte-exact for the trained format; otherwise it is `ws`.
    ows = '""' if compact else "ws"
    if not compact:
        b.use_shared("ws")

    b.use_shared("jsonstring")
    b.use_shared("jsonvalue")  # pulls jsonobject/jsonarray/jsonnumber + ws

    # actionname ::= "\"A\"" | "\"B\"" | ...
    b.rule("actionname", " | ".join(_json_str_lit(n) for n in names))

    # args rule: free object, or per-action object when --with-args has specs.
    if with_args and arg_specs:
        # One `args_<name>` rule per action; `args` picks based on context (the
        # grammar can't actually condition on the *sibling* `name` value within
        # GBNF, so we expose each as an alternative — the harness's real
        # implementation would condition properly. For the reference grammar
        # we still want every per-action shape to be *accepted*, so the union
        # is the right superset.)
        args_alts: list[str] = []
        for n in names:
            spec = arg_specs.get(n) or {}
            keys = spec.get("keys") or {}
            rule_name = f"args_{_safe_rule_id(n)}"
            args_alts.append(rule_name)
            if not keys:
                # empty object only (action takes no params) — but also accept a
                # free object as a safe superset.
                b.rule(rule_name, "jsonobject")
                continue
            # Build an object whose properties are drawn from `keys`, each
            # optional (presence checks live in validate-tool-args.ts), order
            # not pinned. value: enum literal alternation when an enum is given,
            # else a free JSON value.
            kv_alts: list[str] = []
            for k, kspec in keys.items():
                kspec = kspec or {}
                enum_vals = kspec.get("enum")
                if isinstance(enum_vals, list) and enum_vals and all(isinstance(v, str) for v in enum_vals):
                    val_ref = "(" + " | ".join(_json_str_lit(v) for v in enum_vals) + ")"
                else:
                    val_ref = "jsonvalue"
                kv_alts.append(f"{_json_str_lit(k)} {ows} \":\" {ows} {val_ref}")
            one_kv = "(" + " | ".join(kv_alts) + ")"
            body = f'"{{" {ows} ( {one_kv} ( {ows} "," {ows} {one_kv} )* )? {ows} "}}"'
            b.rule(rule_name, body)
        b.rule("args", " | ".join(args_alts))
        args_ref = "args"
    else:
        args_ref = "jsonobject"

    # toolcall ::= "{" "\"id\":" jsonstring "," "\"name\":" actionname "," "\"args\":" <args> "}"
    b.rule(
        "toolcall",
        " ".join(
            [
                '"{"', ows,
                _lit('"id":'), ows, "jsonstring", ows, '","', ows,
                _lit('"name":'), ows, "actionname", ows, '","', ows,
                _lit('"args":'), ows, args_ref, ows,
                '"}"',
            ]
        ),
    )
    # toolcalls ::= "[" ( toolcall ( "," toolcall )* )? "]"
    b.rule(
        "toolcalls",
        f'"[" {ows} ( toolcall ( {ows} "," {ows} toolcall )* )? {ows} "]"',
    )

    # root ::= "{" "\"thought\":" jsonstring "," "\"toolCalls\":" toolcalls ( "," "\"messageToUser\":" jsonstring )? "}"
    root_parts = [
        '"{"', ows,
        _lit('"thought":'), ows, "jsonstring", ows, '","', ows,
        _lit('"toolCalls":'), ows, "toolcalls", ows,
        f'( "," {ows} {_lit(chr(34) + "messageToUser" + chr(34) + ":")} {ows} jsonstring {ows} )?',
        '"}"',
    ]
    b.root(root_parts)
    return b.build()


def _safe_rule_id(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", name).lower()


# ---------------------------------------------------------------------------
# Action-name / arg-spec sources
# ---------------------------------------------------------------------------


def _names_from_csv(csv: str) -> list[str]:
    return [s.strip() for s in csv.split(",") if s.strip()]


def _from_action_docs_ts(path: Path, *, with_args: bool) -> tuple[list[str], dict[str, dict[str, Any]]]:
    """Best-effort extract of action names (and arg keys/enums) from the
    generated `action-docs.ts`. We only scan the `allActionsSpec` block. The
    TS is JSON-ish but not JSON; we use targeted regexes — robust enough for
    name extraction and a best-effort arg-key/enum pass."""
    src = path.read_text(encoding="utf-8")
    # The block is `export const allActionsSpec = { ... \n} as const ...;` —
    # the `as const` line may carry a `satisfies {...}` suffix. Capture up to
    # the first line that begins `} as const` after the declaration.
    m = re.search(
        r"export\s+const\s+allActionsSpec\s*=\s*\{(.*?)\n\}\s*as\s+const\b",
        src,
        re.S,
    )
    if m is None:
        m = re.search(
            r"export\s+const\s+coreActionsSpec\s*=\s*\{(.*?)\n\}\s*as\s+const\b",
            src,
            re.S,
        )
    block = m.group(1) if m else src
    # Action objects: `{ name: "X", ... }` — capture name + a window of the
    # object body (greedy-but-bounded) for the arg pass.
    names: list[str] = []
    arg_specs: dict[str, dict[str, Any]] = {}
    for am in re.finditer(r"\bname:\s*\"([A-Z0-9_]+)\"", block):
        names.append(am.group(1))
    names = sorted(dict.fromkeys(names))
    if with_args:
        # Per action, find `name: "X"` then the nearest following `parameters: [ ... ]`
        # and pull `name: "k"` (+ `enum: ["a","b"]`) pairs out of it. Bounded
        # window to avoid bleeding into the next action.
        for am in re.finditer(r"\bname:\s*\"([A-Z0-9_]+)\"([\s\S]{0,8000}?)(?=\bname:\s*\"[A-Z0-9_]+\"|$)", block):
            act = am.group(1)
            window = am.group(2)
            pm = re.search(r"parameters:\s*(\[[\s\S]*?\])\s*,?\s*(?:examples|exampleCalls|similes|\})", window)
            keys: dict[str, Any] = {}
            if pm:
                pbody = pm.group(1)
                # Nested `{ ... }` (the per-param `schema`) defeats a
                # balanced-brace regex; instead walk `name: "k"` tokens and
                # associate the nearest following `enum:` / `required:` that
                # appears before the next `name:` token. Within a `parameters`
                # array literal the only `name:` keys are parameter names.
                tokens = [(m.start(), m.group(1)) for m in re.finditer(r'\bname:\s*"([A-Za-z0-9_]+)"', pbody)]
                for idx, (pos, k) in enumerate(tokens):
                    end = tokens[idx + 1][0] if idx + 1 < len(tokens) else len(pbody)
                    seg = pbody[pos:end]
                    spec: dict[str, Any] = {}
                    em = re.search(r"enum:\s*\[([^\]]*)\]", seg)
                    if em:
                        ev = re.findall(r'"([^"]*)"', em.group(1))
                        if ev:
                            spec["enum"] = ev
                    rm = re.search(r"required:\s*(true|false)", seg)
                    if rm:
                        spec["required"] = rm.group(1) == "true"
                    keys[k] = spec
            if keys:
                arg_specs[act] = {"keys": keys}
    return names, arg_specs


def _from_catalog_json(path: Path, *, with_args: bool) -> tuple[list[str], dict[str, dict[str, Any]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    actions: list[dict[str, Any]] = []
    if isinstance(data, list):
        actions = [a for a in data if isinstance(a, dict)]
    elif isinstance(data, dict):
        if isinstance(data.get("actions"), list):
            actions = [a for a in data["actions"] if isinstance(a, dict)]
        else:
            for v in data.values():
                if isinstance(v, list):
                    actions.extend(a for a in v if isinstance(a, dict))
    names: list[str] = []
    arg_specs: dict[str, dict[str, Any]] = {}
    for a in actions:
        n = a.get("name")
        if not isinstance(n, str) or not n:
            continue
        names.append(n)
        if with_args:
            params = a.get("parameters")
            keys: dict[str, Any] = {}
            if isinstance(params, list):
                for p in params:
                    if not isinstance(p, dict):
                        continue
                    k = p.get("name")
                    if not isinstance(k, str) or not k:
                        continue
                    spec: dict[str, Any] = {}
                    sch = p.get("schema") if isinstance(p.get("schema"), dict) else p
                    enum_vals = sch.get("enum") if isinstance(sch, dict) else None
                    if isinstance(enum_vals, list) and enum_vals and all(isinstance(v, str) for v in enum_vals):
                        spec["enum"] = enum_vals
                    if isinstance(p.get("required"), bool):
                        spec["required"] = p["required"]
                    keys[k] = spec
            elif isinstance(params, dict):
                props = params.get("properties")
                req = params.get("required") if isinstance(params.get("required"), list) else []
                if isinstance(props, dict):
                    for k, sch in props.items():
                        spec = {}
                        if isinstance(sch, dict) and isinstance(sch.get("enum"), list):
                            ev = [v for v in sch["enum"] if isinstance(v, str)]
                            if ev:
                                spec["enum"] = ev
                        if k in req:
                            spec["required"] = True
                        keys[k] = spec
            if keys:
                arg_specs[n] = {"keys": keys}
    return sorted(dict.fromkeys(names)), arg_specs


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _resolve_sources(args: argparse.Namespace) -> tuple[list[str], dict[str, dict[str, Any]]]:
    if args.names:
        return sorted(dict.fromkeys(_names_from_csv(args.names))), {}
    if args.action_docs:
        return _from_action_docs_ts(Path(args.action_docs), with_args=args.with_args)
    if args.catalog:
        return _from_catalog_json(Path(args.catalog), with_args=args.with_args)
    raise SystemExit("emit_native_grammar: provide one of --names / --action-docs / --catalog")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_argument_group("action source (pick one)")
    src.add_argument("--names", help="comma-separated action names")
    src.add_argument("--action-docs", help="path to packages/core/src/generated/action-docs.ts")
    src.add_argument("--catalog", help="path to an actions-catalog JSON file")
    p.add_argument("--with-args", action="store_true", help="also constrain per-action args keys/enums")
    p.add_argument("--no-compact", action="store_true", help="permit insignificant whitespace (default: compact, matching native_record.py)")
    p.add_argument("--out", help="write GBNF here (default: stdout)")
    args = p.parse_args(argv)

    names, arg_specs = _resolve_sources(args)
    gbnf = build_native_envelope_gbnf(
        names,
        arg_specs=arg_specs,
        with_args=args.with_args,
        compact=not args.no_compact,
    )
    if args.out:
        Path(args.out).write_text(gbnf, encoding="utf-8")
        print(f"wrote {Path(args.out)} ({len(names)} actions, with_args={args.with_args})", file=sys.stderr)
    else:
        sys.stdout.write(gbnf)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
