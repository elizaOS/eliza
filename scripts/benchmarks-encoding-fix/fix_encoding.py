"""Patch Python files under packages/benchmarks to force encoding='utf-8'
on text I/O. Skips vendored upstream, node_modules, virtualenvs, caches.

Handles nested parentheses by scanning manually for balanced parens after
seeing the opening pattern.
"""
import sys
from pathlib import Path

ROOT = Path("packages/benchmarks")
EXCLUDE_PARTS = {
    "upstream",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".tox",
    "build",
    "dist",
    ".pytest_cache",
}

TEXT_MODES = {"w", "a", "x", "r", "w+", "a+", "r+", "wt", "rt", "at",
              "x+", "xt", "tw", "tr", "ta"}


def should_skip(p: Path) -> bool:
    parts = set(p.parts)
    if parts & EXCLUDE_PARTS:
        return True
    for part in p.parts:
        if part.endswith(".egg-info"):
            return True
    return False


def find_matching_paren(s: str, open_idx: int) -> int:
    """Given index of '(' in s, return index of matching ')'.
    Respects single and double quoted strings (including triple-quoted)
    and skips escapes inside strings."""
    assert s[open_idx] == "("
    depth = 0
    i = open_idx
    n = len(s)
    while i < n:
        ch = s[i]
        if ch in ("'", '"'):
            # detect triple-quote
            if s[i:i+3] == ch * 3:
                end = s.find(ch * 3, i + 3)
                if end == -1:
                    return -1
                i = end + 3
                continue
            # single-quoted: find end of string, skipping escapes
            quote = ch
            j = i + 1
            while j < n:
                if s[j] == "\\":
                    j += 2
                    continue
                if s[j] == quote:
                    break
                j += 1
            i = j + 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
        elif ch == "#":
            # python comment to end of line
            nl = s.find("\n", i)
            if nl == -1:
                return -1
            i = nl + 1
            continue
        i += 1
    return -1


def split_top_level_args(args: str) -> list[str]:
    """Split a comma-separated argument list at depth 0, respecting strings
    and nested brackets."""
    parts: list[str] = []
    depth = 0
    bracket = 0
    brace = 0
    i = 0
    start = 0
    n = len(args)
    while i < n:
        ch = args[i]
        if ch in ("'", '"'):
            if args[i:i+3] == ch * 3:
                end = args.find(ch * 3, i + 3)
                if end == -1:
                    break
                i = end + 3
                continue
            quote = ch
            j = i + 1
            while j < n:
                if args[j] == "\\":
                    j += 2
                    continue
                if args[j] == quote:
                    break
                j += 1
            i = j + 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "[":
            bracket += 1
        elif ch == "]":
            bracket -= 1
        elif ch == "{":
            brace += 1
        elif ch == "}":
            brace -= 1
        elif ch == "," and depth == 0 and bracket == 0 and brace == 0:
            parts.append(args[start:i])
            start = i + 1
        i += 1
    parts.append(args[start:])
    return parts


def patch_call(src: str, callname_predicate) -> tuple[str, int]:
    """Find calls where the callable name matches the predicate and inject
    encoding="utf-8" if appropriate.

    callname_predicate: function(token_before_paren) -> kind:
        "text"  - text I/O that should get encoding
        "open"  - generic open(); check mode argument
        None    - skip
    """
    out: list[str] = []
    i = 0
    n = len(src)
    changes = 0

    while i < n:
        # walk forward through strings and comments to find the next real '('
        lparen = -1
        scan = i
        while scan < n:
            ch = src[scan]
            if ch in ("'", '"'):
                # triple-quoted?
                if src[scan:scan+3] == ch * 3:
                    end = src.find(ch * 3, scan + 3)
                    if end == -1:
                        scan = n
                        break
                    scan = end + 3
                    continue
                # single-quoted, find end skipping escapes
                quote = ch
                m = scan + 1
                while m < n:
                    if src[m] == "\\":
                        m += 2
                        continue
                    if src[m] == "\n":
                        break  # unterminated; treat as ended
                    if src[m] == quote:
                        break
                    m += 1
                scan = m + 1
                continue
            if ch == "#":
                nl = src.find("\n", scan)
                if nl == -1:
                    scan = n
                    break
                scan = nl + 1
                continue
            if ch == "(":
                lparen = scan
                break
            scan += 1
        if lparen == -1:
            out.append(src[i:])
            break
        # find the identifier just before '(' (allow whitespace)
        j = lparen - 1
        while j >= 0 and src[j] in " \t":
            j -= 1
        # collect identifier characters (letters/digits/_)
        k = j
        while k >= 0 and (src[k].isalnum() or src[k] in "_."):
            k -= 1
        token = src[k+1:j+1]
        # also look at what's before to ensure it's a real call (not def)
        # We just check the immediate token.
        token_start = k + 1
        kind = callname_predicate(token, src, token_start)
        kind_token = token.rsplit(".", 1)[-1] if token else ""
        rparen = find_matching_paren(src, lparen)
        if rparen == -1 or not kind:
            out.append(src[i:lparen+1])
            i = lparen + 1
            continue

        # got a call
        args_str = src[lparen+1:rparen]
        args = split_top_level_args(args_str)
        # strip
        stripped = [a.strip() for a in args]
        # Skip if empty
        non_empty = [a for a in stripped if a]

        # Check if any kwarg has encoding=
        has_encoding = any(a.startswith("encoding=") or a.startswith("encoding =") for a in non_empty)
        if has_encoding:
            out.append(src[i:rparen+1])
            i = rparen + 1
            continue

        if kind == "open":
            # determine mode: positional arg index 1 or kwarg mode=
            mode_val: str | None = None
            mode_kw = next((a for a in non_empty if a.startswith("mode=") or a.startswith("mode =")), None)
            if mode_kw:
                v = mode_kw.split("=", 1)[1].strip()
                mode_val = v.strip("'\"")
            else:
                # positional - look at index 1
                # But only positional args (no =)
                positionals = []
                for a in non_empty:
                    if "=" in a and not a.strip().startswith("="):
                        # check if it's a kwarg (name=...) vs default (a==b)
                        eq = a.find("=")
                        before = a[:eq].strip()
                        if before.isidentifier():
                            break
                    positionals.append(a)
                if len(positionals) >= 2:
                    mv = positionals[1].strip()
                    if (mv.startswith("'") and mv.endswith("'")) or (mv.startswith('"') and mv.endswith('"')):
                        mode_val = mv[1:-1]
                elif len(positionals) == 1:
                    # default mode is 'r'
                    mode_val = "r"
            if mode_val is None:
                # dynamic mode - skip to be safe
                out.append(src[i:rparen+1])
                i = rparen + 1
                continue
            if "b" in mode_val:
                out.append(src[i:rparen+1])
                i = rparen + 1
                continue
            if mode_val not in TEXT_MODES:
                out.append(src[i:rparen+1])
                i = rparen + 1
                continue
            # Inject encoding="utf-8" as last kwarg
            new_call = inject_encoding(src[lparen+1:rparen])
            out.append(src[i:lparen+1] + new_call + ")")
            i = rparen + 1
            changes += 1
            continue

        if kind == "text":
            # write_text(data[, encoding, errors, newline]) / read_text([encoding, errors])
            # Skip if a positional encoding argument is already present.
            # Determine positional vs kwargs in non_empty.
            positionals: list[str] = []
            saw_kwarg = False
            for a in non_empty:
                if saw_kwarg:
                    break
                eq = a.find("=")
                if eq != -1:
                    head = a[:eq].strip()
                    if head.isidentifier():
                        saw_kwarg = True
                        continue
                positionals.append(a)
            method = kind_token  # "write_text" or "read_text"
            if method == "write_text" and len(positionals) >= 2:
                # already has positional encoding
                out.append(src[i:rparen+1])
                i = rparen + 1
                continue
            if method == "read_text" and len(positionals) >= 1:
                # already has positional encoding
                out.append(src[i:rparen+1])
                i = rparen + 1
                continue
            new_call = inject_encoding(src[lparen+1:rparen])
            out.append(src[i:lparen+1] + new_call + ")")
            i = rparen + 1
            changes += 1
            continue

        # fallthrough
        out.append(src[i:lparen+1])
        i = lparen + 1

    return "".join(out), changes


def inject_encoding(args: str) -> str:
    """Append encoding="utf-8" to an existing argument list string."""
    if not args.strip():
        return 'encoding="utf-8"'
    # preserve original; need to be careful about trailing commas / whitespace
    # Find if there's a trailing comma (e.g. multiline call)
    stripped = args.rstrip()
    if stripped.endswith(","):
        return args + ' encoding="utf-8"'
    # If the args span multiple lines, try to indent reasonably by adding
    # comma + space inline
    return args + ', encoding="utf-8"'


def predicate(token: str, src: str, token_start_idx: int) -> str | None:
    # Skip if this is a def/class definition
    # token is the call name; need to check what comes before token
    # Look at the start of the current line up to the token
    line_start = src.rfind("\n", 0, token_start_idx) + 1
    line_prefix = src[line_start:token_start_idx]
    sp = line_prefix.strip()
    if sp.endswith("def") or sp.endswith("class") or sp.endswith("async def"):
        return None
    if token == "open":
        # also catch io.open
        return "open"
    if token.endswith(".open"):
        return "open"
    if token.endswith(".write_text"):
        return "text"
    if token.endswith(".read_text"):
        return "text"
    return None


def main() -> None:
    files_changed: list[tuple[Path, int]] = []
    total_changes = 0
    for path in sorted(ROOT.rglob("*.py")):
        if should_skip(path):
            continue
        try:
            raw = path.read_bytes()
            src = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        new_src, changes = patch_call(src, predicate)
        if changes and new_src != src:
            path.write_bytes(new_src.encode("utf-8"))
            files_changed.append((path, changes))
            total_changes += changes
            print(f"  patched {changes:3d} in {path}")

    print(f"\nTotal files changed: {len(files_changed)}")
    print(f"Total call sites patched: {total_changes}")

    pkgs: dict[str, int] = {}
    for p, c in files_changed:
        rel = p.relative_to(ROOT)
        pkg = rel.parts[0]
        pkgs[pkg] = pkgs.get(pkg, 0) + c
    print("\nCall sites patched per package:")
    for pkg, n in sorted(pkgs.items()):
        print(f"  {pkg}: {n}")


if __name__ == "__main__":
    main()
