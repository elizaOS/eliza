"""Build /home/shaw/milady/training/data/prompts/actions-catalog.json.

Sources:
- eliza/plugins/<plugin>/typescript/generated/specs/specs.ts (auto-generated; clean)
- direct parse of action TS files for plugins that don't ship a specs file

For each plugin we de-duplicate by action name, preferring the spec-derived
record (which has compressed descriptions, similes, and examples).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ELIZA_ROOT = Path(__file__).parent.parent.parent.parent.resolve()
TRAINING_ROOT = Path(__file__).parent.parent.resolve()
OUT_PATH = TRAINING_ROOT / "data" / "prompts" / "actions-catalog.json"

# ---------------------------------------------------------------------------
# spec.ts parser
# ---------------------------------------------------------------------------

# Match an "actions: [ ... ]" array literal inside an `as const` declaration.
ACTIONS_BLOCK_RE = re.compile(
    r"export\s+const\s+(?:allActionsSpec|coreActionsSpec)\s*=\s*\{[\s\S]*?actions:\s*(\[[\s\S]*?\])\s*,?\s*\}\s*as\s+const\s*;",
)

# Within an actions block, each action object roughly:
# { name: "X", description: "Y", similes: ["A","B"], parameters: [...], examples: [[...]] }
ACTION_OBJECT_RE = re.compile(r"\{\s*([\s\S]*?)\}\s*,?\s*(?=\{|\]\s*$)")


def _strip_ts_comments(src: str) -> str:
    """Strip line and block comments WHILE respecting strings and template
    literals. Naive regex-based stripping mangles URLs like `https://...`.
    """
    out: list[str] = []
    n = len(src)
    i = 0
    mode_stack: list[str] = ["code"]
    while i < n:
        ch = src[i]
        mode = mode_stack[-1]
        if mode in ("sq", "dq"):
            quote = "'" if mode == "sq" else '"'
            if ch == "\\" and i + 1 < n:
                out.append(src[i : i + 2])
                i += 2
                continue
            if ch == quote:
                mode_stack.pop()
            out.append(ch)
            i += 1
            continue
        if mode == "tpl":
            if ch == "\\" and i + 1 < n:
                out.append(src[i : i + 2])
                i += 2
                continue
            if ch == "`":
                mode_stack.pop()
            elif ch == "$" and i + 1 < n and src[i + 1] == "{":
                mode_stack.append("tpl_expr")
                out.append("${")
                i += 2
                continue
            out.append(ch)
            i += 1
            continue
        # code or tpl_expr
        # comments
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            # skip to newline
            j = src.find("\n", i)
            if j == -1:
                break
            i = j
            continue
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            if j == -1:
                break
            i = j + 2
            continue
        if ch == "'":
            mode_stack.append("sq")
        elif ch == '"':
            mode_stack.append("dq")
        elif ch == "`":
            mode_stack.append("tpl")
        elif ch == "}" and mode == "tpl_expr":
            mode_stack.pop()
        out.append(ch)
        i += 1
    return "".join(out)


def _parse_string(literal: str) -> str:
    literal = literal.strip()
    if literal.startswith('"'):
        return bytes(literal[1:-1], "utf-8").decode("unicode_escape")
    if literal.startswith("'"):
        return literal[1:-1]
    if literal.startswith("`"):
        return literal[1:-1]
    return literal


def _balanced_block(src: str, start: int, open_ch: str, close_ch: str) -> tuple[int, str]:
    """Return (end_idx_exclusive, body) for a balanced bracket block starting at
    `start` (the open char index). Handles single-quoted, double-quoted, and
    template literal strings (including nested `${...}` interpolations).
    """
    assert src[start] == open_ch
    # Mode stack:
    #   "code"      -> normal code; treat braces and start strings on quote chars
    #   "sq" / "dq" -> single/double-quoted string; track escapes; only close on quote
    #   "tpl"       -> template string segment; close on backtick; on `${` push tpl_expr
    #   "tpl_expr"  -> code inside ${...}; on matching `}` pop back to "tpl"
    mode_stack: list[str] = ["code"]
    depth = 0  # only counts braces opened in code/tpl_expr mode
    tpl_expr_depth_stack: list[int] = []  # depth at which each tpl_expr was entered
    i = start
    n = len(src)
    while i < n:
        ch = src[i]
        mode = mode_stack[-1]
        if mode == "sq" or mode == "dq":
            quote = "'" if mode == "sq" else '"'
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                mode_stack.pop()
                i += 1
                continue
            i += 1
            continue
        if mode == "tpl":
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                mode_stack.pop()
                i += 1
                continue
            if ch == "$" and i + 1 < n and src[i + 1] == "{":
                mode_stack.append("tpl_expr")
                tpl_expr_depth_stack.append(depth)
                depth += 1
                i += 2
                continue
            i += 1
            continue
        # mode is "code" or "tpl_expr"
        if ch == "'":
            mode_stack.append("sq")
            i += 1
            continue
        if ch == '"':
            mode_stack.append("dq")
            i += 1
            continue
        if ch == "`":
            mode_stack.append("tpl")
            i += 1
            continue
        if ch == open_ch:
            depth += 1
            i += 1
            continue
        if ch == close_ch:
            # Special case: if we're closing back to a tpl_expr boundary (only
            # relevant when open/close are `{`/`}`).
            if (
                close_ch == "}"
                and mode == "tpl_expr"
                and tpl_expr_depth_stack
                and depth - 1 == tpl_expr_depth_stack[-1]
            ):
                tpl_expr_depth_stack.pop()
                mode_stack.pop()
                depth -= 1
                i += 1
                continue
            depth -= 1
            if depth == 0 and len(mode_stack) == 1:
                return i + 1, src[start : i + 1]
            i += 1
            continue
        # Track inner `{}` so tpl_expr depth tracking still works even when
        # we're scanning an array (open=`[` close=`]`) at top level — but in
        # practice this only matters when the inner code uses template literals.
        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "}":
            if (
                mode == "tpl_expr"
                and tpl_expr_depth_stack
                and depth - 1 == tpl_expr_depth_stack[-1]
            ):
                tpl_expr_depth_stack.pop()
                mode_stack.pop()
            depth -= 1
            i += 1
            continue
        i += 1
    raise ValueError("unbalanced block")


def parse_specs_actions(specs_path: Path) -> list[dict[str, Any]]:
    raw = specs_path.read_text()
    raw = _strip_ts_comments(raw)
    # Find the allActionsSpec block (preferred) else coreActionsSpec
    actions: list[dict[str, Any]] = []
    for marker in ("allActionsSpec", "coreActionsSpec"):
        m = re.search(rf"export\s+const\s+{marker}\s*=\s*\{{", raw)
        if not m:
            continue
        # walk to its matching brace
        end, body = _balanced_block(raw, m.end() - 1, "{", "}")
        # find actions: [
        m2 = re.search(r"actions:\s*\[", body)
        if not m2:
            continue
        end2, arr_body = _balanced_block(body, m2.end() - 1, "[", "]")
        # split the array into top-level objects
        actions = _split_object_array(arr_body)
        if actions:
            break
    return actions


def _split_object_array(arr_body: str) -> list[dict[str, Any]]:
    """Split a TS array literal of objects into a list of parsed dicts."""
    inner = arr_body.strip()[1:-1]  # strip [ ]
    objects: list[str] = []
    i = 0
    while i < len(inner):
        ch = inner[i]
        if ch == "{":
            end, body = _balanced_block(inner, i, "{", "}")
            objects.append(body)
            i = end
        else:
            i += 1
    parsed: list[dict[str, Any]] = []
    for obj in objects:
        parsed.append(_parse_action_object(obj))
    return parsed


def _find_top_level_keys(body: str) -> dict[str, tuple[int, int]]:
    """Return {key_name: (value_start_offset_in_body, value_end_offset)} for keys
    at the top level of an object literal `body` (the outer { ... }, slice
    INCLUDING those braces).
    """
    if not body or body[0] != "{" or body[-1] != "}":
        return {}
    inner = body[1:-1]
    keys: dict[str, tuple[int, int]] = {}
    i = 0
    n = len(inner)
    mode_stack: list[str] = ["code"]
    depth = 0
    tpl_expr_depth_stack: list[int] = []

    def at_top() -> bool:
        return depth == 0 and len(mode_stack) == 1

    while i < n:
        ch = inner[i]
        mode = mode_stack[-1]
        # comment skipping (in case caller didn't strip)
        if mode == "code" or mode == "tpl_expr":
            if ch == "/" and i + 1 < n and inner[i + 1] == "/":
                j = inner.find("\n", i)
                i = n if j == -1 else j
                continue
            if ch == "/" and i + 1 < n and inner[i + 1] == "*":
                j = inner.find("*/", i + 2)
                i = n if j == -1 else j + 2
                continue
        if mode == "sq" or mode == "dq":
            quote = "'" if mode == "sq" else '"'
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == quote:
                mode_stack.pop()
            i += 1
            continue
        if mode == "tpl":
            if ch == "\\" and i + 1 < n:
                i += 2
                continue
            if ch == "`":
                mode_stack.pop()
            elif ch == "$" and i + 1 < n and inner[i + 1] == "{":
                mode_stack.append("tpl_expr")
                tpl_expr_depth_stack.append(depth)
                depth += 1
                i += 2
                continue
            i += 1
            continue
        # mode is code or tpl_expr
        if ch == "'":
            mode_stack.append("sq")
            i += 1
            continue
        if ch == '"':
            mode_stack.append("dq")
            i += 1
            continue
        if ch == "`":
            mode_stack.append("tpl")
            i += 1
            continue
        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "(":
            depth += 1
            i += 1
            continue
        if ch == "[":
            depth += 1
            i += 1
            continue
        if ch == "}":
            if mode == "tpl_expr" and tpl_expr_depth_stack and depth - 1 == tpl_expr_depth_stack[-1]:
                tpl_expr_depth_stack.pop()
                mode_stack.pop()
            depth -= 1
            i += 1
            continue
        if ch in (")", "]"):
            depth -= 1
            i += 1
            continue
        # potential key at top level: identifier followed by `:`
        if at_top() and (ch.isalpha() or ch == "_" or ch == "$"):
            j = i
            while j < n and (inner[j].isalnum() or inner[j] in "_$"):
                j += 1
            ident = inner[i:j]
            k = j
            while k < n and inner[k] in " \t":
                k += 1
            if k < n and inner[k] == ":" and (k + 1 >= n or inner[k + 1] != ":"):
                # value start
                val_start = k + 1
                # find end: next top-level `,` at depth 0
                p = val_start
                local_depth = 0
                local_stack: list[str] = ["code"]
                local_tpl: list[int] = []
                while p < n:
                    cp = inner[p]
                    lmode = local_stack[-1]
                    if lmode == "sq" or lmode == "dq":
                        q = "'" if lmode == "sq" else '"'
                        if cp == "\\" and p + 1 < n:
                            p += 2
                            continue
                        if cp == q:
                            local_stack.pop()
                        p += 1
                        continue
                    if lmode == "tpl":
                        if cp == "\\" and p + 1 < n:
                            p += 2
                            continue
                        if cp == "`":
                            local_stack.pop()
                        elif cp == "$" and p + 1 < n and inner[p + 1] == "{":
                            local_stack.append("tpl_expr")
                            local_tpl.append(local_depth)
                            local_depth += 1
                            p += 2
                            continue
                        p += 1
                        continue
                    if cp == "'":
                        local_stack.append("sq")
                        p += 1
                        continue
                    if cp == '"':
                        local_stack.append("dq")
                        p += 1
                        continue
                    if cp == "`":
                        local_stack.append("tpl")
                        p += 1
                        continue
                    if cp in "{([":
                        local_depth += 1
                        p += 1
                        continue
                    if cp in "})]":
                        if cp == "}" and lmode == "tpl_expr" and local_tpl and local_depth - 1 == local_tpl[-1]:
                            local_tpl.pop()
                            local_stack.pop()
                        local_depth -= 1
                        if local_depth < 0:
                            break
                        p += 1
                        continue
                    if cp == "," and local_depth == 0:
                        break
                    p += 1
                keys[ident] = (val_start, p)
                i = p
                continue
            i = j
            continue
        i += 1
    return keys


def _parse_parameters_array(arr_src: str) -> list[dict[str, Any]]:
    """Parse a TS array literal of `{ name, description, required?, schema? }` parameter
    descriptors into a list of dicts. Best-effort.
    """
    if not arr_src or not arr_src.startswith("[") or not arr_src.endswith("]"):
        return []
    inner = arr_src[1:-1]
    objects: list[str] = []
    i = 0
    n = len(inner)
    while i < n:
        ch = inner[i]
        if ch == "{":
            try:
                end, body = _balanced_block(inner, i, "{", "}")
            except ValueError:
                break
            objects.append(body)
            i = end
        else:
            i += 1
    parsed: list[dict[str, Any]] = []
    for obj in objects:
        keys = _find_top_level_keys(obj)
        body_inner = obj[1:-1]

        def _slice(name: str) -> str | None:
            v = keys.get(name)
            if v is None:
                return None
            return body_inner[v[0] : v[1]].strip().rstrip(",").strip()

        entry: dict[str, Any] = {}
        nm = _slice("name")
        if nm:
            sm = re.match(r'^("[^"]*"|\'[^\']*\')', nm)
            entry["name"] = _parse_string(sm.group(1)) if sm else nm
        dv = _slice("description")
        if dv:
            entry["description"] = _parse_concatenated_strings(dv) or dv
        rv = _slice("required")
        if rv is not None:
            rv = rv.strip()
            entry["required"] = rv == "true"
        else:
            entry["required"] = True
        sv = _slice("schema")
        if sv is not None:
            tm = re.search(r'type\s*:\s*"([^"]+)"', sv)
            if tm:
                entry["type"] = tm.group(1)
        if entry.get("name"):
            parsed.append(entry)
    return parsed


def _parse_action_object(obj_src: str) -> dict[str, Any]:
    """Best-effort parser for a TS object literal describing an action.

    Pulls only TOP-LEVEL keys, so inner objects (e.g. parameters[].name) don't
    pollute the result.
    """
    body = obj_src.strip()
    keys = _find_top_level_keys(body)
    inner = body[1:-1] if body.startswith("{") and body.endswith("}") else body

    out: dict[str, Any] = {}

    def slice_value(name: str) -> str | None:
        v = keys.get(name)
        if v is None:
            return None
        return inner[v[0] : v[1]].strip().rstrip(",").strip()

    # name
    nv = slice_value("name")
    if nv is not None:
        sm = re.match(r'^("[^"]*"|\'[^\']*\'|`[^`]*`)', nv)
        if sm:
            out["name"] = _parse_string(sm.group(1))
        else:
            out["_name_expr"] = nv  # raw expression to be resolved later

    # description (handle concatenated strings)
    dv = slice_value("description")
    if dv is not None:
        out["description"] = _parse_concatenated_strings(dv) or dv

    dcv = slice_value("descriptionCompressed")
    if dcv is not None:
        out["descriptionCompressed"] = _parse_concatenated_strings(dcv) or dcv

    sv = slice_value("similes")
    if sv is not None and sv.startswith("["):
        out["similes"] = [a or b for (a, b) in re.findall(r'"([^"]+)"|\'([^\']+)\'', sv)]

    pv = slice_value("parameters")
    if pv is not None and pv.startswith("["):
        out["parameters_raw"] = pv
        out["parameters"] = _parse_parameters_array(pv)

    return out


def _parse_concatenated_strings(expr: str) -> str | None:
    """Parse `"a" + "b" + "c"` into a single string. Returns None if not all
    parts are string literals."""
    parts: list[str] = []
    i = 0
    n = len(expr)
    while i < n:
        while i < n and expr[i] in " \t\n\r":
            i += 1
        if i >= n:
            break
        ch = expr[i]
        if ch in ('"', "'", "`"):
            quote = ch
            j = i + 1
            while j < n:
                if expr[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if expr[j] == quote:
                    break
                j += 1
            if j >= n:
                return None
            parts.append(_parse_string(expr[i : j + 1]))
            i = j + 1
            while i < n and expr[i] in " \t\n\r":
                i += 1
            if i < n and expr[i] == "+":
                i += 1
                continue
            break
        return None
    return "".join(parts) if parts else None




# ---------------------------------------------------------------------------
# action-file parser (for plugins without specs.ts coverage)
# ---------------------------------------------------------------------------


_ENUM_CACHE: dict[Path, dict[str, dict[str, str]]] = {}


def _collect_const_enums(plugin_dir: Path) -> dict[str, dict[str, str]]:
    """Parse `export const EnumName = { KEY: "VAL", ... } as const;` from any TS
    file in a plugin's source tree (excluding node_modules / dist / generated /
    tests), returning {EnumName: {KEY: VAL}}.
    """
    if plugin_dir in _ENUM_CACHE:
        return _ENUM_CACHE[plugin_dir]
    enums: dict[str, dict[str, str]] = {}
    for p in plugin_dir.rglob("*.ts"):
        if any(part in {"node_modules", "dist", "generated", "__tests__"} for part in p.parts):
            continue
        if p.name.endswith(".test.ts") or p.name.endswith(".d.ts"):
            continue
        try:
            src = _strip_ts_comments(p.read_text())
        except Exception:  # noqa: BLE001
            continue
        for m in re.finditer(r"export\s+const\s+(\w+)\s*=\s*\{", src):
            enum_name = m.group(1)
            try:
                _, body = _balanced_block(src, m.end() - 1, "{", "}")
            except ValueError:
                continue
            # only treat as enum if every value is a string literal at top level
            members: dict[str, str] = {}
            for em in re.finditer(r'(\w+)\s*:\s*[\"\']([^\"\']+)[\"\']', body):
                members[em.group(1)] = em.group(2)
            if members and enum_name not in enums:
                enums[enum_name] = members
    _ENUM_CACHE[plugin_dir] = enums
    return enums


def parse_action_ts_file(path: Path, plugin_root: Path | None = None) -> list[dict[str, Any]]:
    """Extract Action objects from a TS file. Strategy: locate `handler:` (Actions
    always have handlers), walk back to the enclosing `{`, parse that object.

    Resolves:
    - `name: spec.name` from `const spec = requireActionSpec("X")`
    - `name: EnumName.MEMBER` from `export const EnumName = {...}` in constants.ts
    """
    src = path.read_text()
    src_no_comments = _strip_ts_comments(src)

    # Pre-collect spec aliases: `const spec = requireActionSpec("CREATE_POLL");`
    spec_aliases: dict[str, str] = {}
    for m in re.finditer(
        r"(?:const|let|var)\s+(\w+)\s*=\s*requireActionSpec\(\s*[\"']([^\"']+)[\"']\s*\)",
        src_no_comments,
    ):
        spec_aliases[m.group(1)] = m.group(2)

    # Pre-collect plain string consts in this file (e.g. `export const X = "Y";`)
    string_consts: dict[str, str] = {}
    for m in re.finditer(
        r"(?:export\s+)?const\s+(\w+)\s*=\s*[\"']([^\"']+)[\"']",
        src_no_comments,
    ):
        string_consts[m.group(1)] = m.group(2)

    enums: dict[str, dict[str, str]] = (
        _collect_const_enums(plugin_root) if plugin_root else {}
    )

    results: list[dict[str, Any]] = []

    # Find action object starts.
    starts: list[int] = []
    # Pattern 1: `: Action = {` direct const/let assignments
    for m in re.finditer(
        r":\s*(?:Action|ActionDefinition)\s*=\s*\{",
        src_no_comments,
    ):
        starts.append(m.end() - 1)
    # Pattern 2: arrow return `: Action => ({`
    for m in re.finditer(
        r":\s*(?:Action|ActionDefinition)\s*=>\s*\(\{",
        src_no_comments,
    ):
        starts.append(m.end() - 1)
    # Pattern 3: function-returned Action: `: Action {` followed somewhere by
    # `return {` (top-level within that function body). Heuristic: locate the
    # function body, then within it find the first `return {`.
    for m in re.finditer(
        r":\s*(?:Action|ActionDefinition)\s*\{",
        src_no_comments,
    ):
        # the `{` we matched is the FUNCTION BODY brace, not the action object.
        body_start = m.end() - 1
        try:
            _, fn_body = _balanced_block(src_no_comments, body_start, "{", "}")
        except ValueError:
            continue
        # find a `return {` inside the function body
        rm = re.search(r"\breturn\s*\{", fn_body)
        if rm:
            # offset back into src_no_comments coordinates
            starts.append(body_start + rm.end() - 1)

    seen_starts: set[int] = set()
    starts_unique: list[int] = []
    for s in starts:
        if s in seen_starts:
            continue
        seen_starts.add(s)
        starts_unique.append(s)
    starts = starts_unique

    for start in starts:
        try:
            _, body = _balanced_block(src_no_comments, start, "{", "}")
        except ValueError:
            continue
        action = _parse_action_object(body)

        # Resolve name from expression if literal absent
        name = action.get("name")
        name_expr = action.pop("_name_expr", None)
        if (not name) and name_expr:
            ne = name_expr.strip().rstrip(",")
            # spec.name
            m = re.match(r"^(\w+)\s*\.\s*name$", ne)
            if m and m.group(1) in spec_aliases:
                name = spec_aliases[m.group(1)]
                action["name"] = name
                action["_resolved_from_spec"] = True
            else:
                # EnumName.MEMBER
                m = re.match(r"^(\w+)\s*\.\s*(\w+)$", ne)
                if m and m.group(1) in enums and m.group(2) in enums[m.group(1)]:
                    name = enums[m.group(1)][m.group(2)]
                    action["name"] = name
                    action["_resolved_from_enum"] = True
                elif re.match(r"^[A-Z_][A-Z0-9_]+$", ne) and ne in string_consts:
                    name = string_consts[ne]
                    action["name"] = name
                    action["_resolved_from_const"] = True

        if "description" not in action:
            # description: spec.description fallback handling
            desc_keys = re.search(r"\bdescription\s*:\s*(\w+)\s*\.\s*description\b", body[:200])
            if desc_keys and desc_keys.group(1) in spec_aliases:
                action["description"] = f"{spec_aliases[desc_keys.group(1)]} action"

        if not name:
            continue
        if not isinstance(name, str):
            continue
        if not re.match(r"^[A-Z][A-Z0-9_\-]*$", name):
            continue
        results.append(action)

    seen: dict[str, dict[str, Any]] = {}
    for r in results:
        name = r["name"]
        if name in seen:
            if len(r) > len(seen[name]):
                seen[name] = r
        else:
            seen[name] = r
    return list(seen.values())


# ---------------------------------------------------------------------------
# example extraction
# ---------------------------------------------------------------------------

EXAMPLE_BLOCK_RE = re.compile(r"\bexamples\s*:\s*\[")


def extract_first_example_call(src: str) -> dict[str, Any] | None:
    """Find the first user message in an action's `examples: [[...]]` array."""
    m = EXAMPLE_BLOCK_RE.search(src)
    if not m:
        return None
    try:
        _, body = _balanced_block(src, m.end() - 1, "[", "]")
    except ValueError:
        return None
    # First user content text — match `text: "..."`
    tm = re.search(r"text\s*:\s*(\"[^\"]+\"|'[^']+'|`[^`]+`)", body)
    if not tm:
        return None
    return {"text": _parse_string(tm.group(1))}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def gather_action_dirs() -> list[tuple[str, Path]]:
    """Return (plugin_name, action_dir) pairs."""
    result: list[tuple[str, Path]] = []
    for plugin_dir in sorted((ELIZA_ROOT / "plugins").iterdir()):
        if not plugin_dir.is_dir():
            continue
        # Look for typescript subtree first
        candidates = [
            plugin_dir / "typescript" / "src" / "actions",
            plugin_dir / "typescript" / "actions",
            plugin_dir / "src" / "actions",
        ]
        for c in candidates:
            if c.is_dir():
                result.append((plugin_dir.name, c))
                break
    return result


SKIP_FILES = {
    "index.ts",
    "actionResultSemantics.ts",
    "action-utils.ts",
    "parse-helpers.ts",
    "validators.ts",
    "helpers.ts",
    "x-feed-helpers.ts",
    "x-feed-adapter.ts",
    "coding-task-helpers.ts",
    "eval-metadata.ts",
}


def gather_action_files(action_dir: Path) -> list[Path]:
    files: list[Path] = []
    for p in action_dir.rglob("*.ts"):
        if p.name in SKIP_FILES:
            continue
        if p.name.endswith(".test.ts") or p.name.endswith(".d.ts"):
            continue
        if "__tests__" in p.parts:
            continue
        files.append(p)
    return files


def main() -> None:
    actions: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str]] = set()  # (plugin, name)

    # ---- Pass 1: harvest from specs.ts (clean / canonical) ----
    plugin_specs: dict[str, list[dict[str, Any]]] = {}
    for spec_file in sorted(ELIZA_ROOT.glob("plugins/*/typescript/generated/specs/specs.ts")):
        plugin = spec_file.parents[3].name
        try:
            specs = parse_specs_actions(spec_file)
        except Exception as exc:  # noqa: BLE001
            print(f"warn: spec parse failed for {plugin}: {exc}")
            continue
        plugin_specs[plugin] = specs

    # ---- Pass 2: parse individual action files ----
    plugin_actions_files: dict[str, list[tuple[Path, list[dict[str, Any]]]]] = {}
    for plugin, action_dir in gather_action_dirs():
        files = gather_action_files(action_dir)
        plugin_root = ELIZA_ROOT / "plugins" / plugin
        per_file: list[tuple[Path, list[dict[str, Any]]]] = []
        for f in files:
            try:
                acts = parse_action_ts_file(f, plugin_root=plugin_root)
            except Exception:  # noqa: BLE001
                acts = []
            per_file.append((f, acts))
        plugin_actions_files[plugin] = per_file

    # ---- Merge: for each spec action, locate its source file in the plugin ----
    for plugin, specs in plugin_specs.items():
        files = plugin_actions_files.get(plugin, [])
        for spec in specs:
            name = spec.get("name")
            if not name:
                continue
            # Skip placeholder spec entries (e.g. `name: "name"` in unfilled specs.ts).
            # The unfilled discord/elizacloud generated specs ship a single action
            # with name="name" and an empty description; ignore it.
            if name == "name":
                continue
            # Also skip lowercase pseudo-names that don't match Eliza convention.
            if not re.match(r"^[A-Z][A-Z0-9_]+$", name):
                continue
            # Find the file that contains this action name
            source_path: str | None = None
            example_call = None
            for f, acts in files:
                if any(a.get("name") == name for a in acts):
                    source_path = str(f.relative_to(ELIZA_ROOT.parent))
                    example_call = extract_first_example_call(f.read_text())
                    break
            # Try to enrich from direct-parsed action object if present.
            direct_params: list[dict[str, Any]] | None = None
            for f, acts in files:
                if any(a.get("name") == name for a in acts):
                    for a in acts:
                        if a.get("name") == name and a.get("parameters"):
                            direct_params = a.get("parameters")
                            break
                    break
            actions.append(
                {
                    "name": name,
                    "plugin": plugin,
                    "source_path": source_path,
                    "description": spec.get("description"),
                    "description_compressed": spec.get("descriptionCompressed"),
                    "similes": spec.get("similes", []),
                    "parameters": direct_params,
                    "parameters_raw": spec.get("parameters_raw"),
                    "example_call": example_call,
                    "source": "spec",
                }
            )
            seen_keys.add((plugin, name))

    # ---- Merge: for plugins without specs, fall back to direct parse ----
    for plugin, files in plugin_actions_files.items():
        for f, acts in files:
            for a in acts:
                name = a.get("name")
                if not name or (plugin, name) in seen_keys:
                    continue
                actions.append(
                    {
                        "name": name,
                        "plugin": plugin,
                        "source_path": str(f.relative_to(ELIZA_ROOT.parent)),
                        "description": a.get("description"),
                        "description_compressed": a.get("descriptionCompressed"),
                        "similes": a.get("similes", []),
                        "parameters": a.get("parameters"),
                        "parameters_raw": a.get("parameters_raw"),
                        "example_call": extract_first_example_call(f.read_text()),
                        "source": "direct",
                    }
                )
                seen_keys.add((plugin, name))

    actions.sort(key=lambda a: (a["plugin"], a["name"]))
    out = {
        "version": 1,
        "n_actions": len(actions),
        "n_plugins": len({a["plugin"] for a in actions}),
        "actions": actions,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2))
    by_plugin: dict[str, int] = {}
    for a in actions:
        by_plugin[a["plugin"]] = by_plugin.get(a["plugin"], 0) + 1
    print(f"wrote {OUT_PATH} actions={len(actions)} plugins={len(by_plugin)}")
    for p in sorted(by_plugin):
        print(f"  {p}: {by_plugin[p]}")


if __name__ == "__main__":
    main()
