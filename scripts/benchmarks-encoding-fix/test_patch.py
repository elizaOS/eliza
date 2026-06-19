"""Quick unit test for the patch_call function."""
import sys
sys.path.insert(0, ".")
from fix_encoding import patch_call, predicate

CASES = [
    # input, expected_changes, expected_substring
    ('with open(path, "w") as f:', 1, 'open(path, "w", encoding="utf-8")'),
    ('with open(path, "wb") as f:', 0, 'open(path, "wb")'),
    ('open(path, "r", encoding="utf-8")', 0, 'encoding="utf-8"'),
    ('open(Path("a.txt"), "w")', 1, 'open(Path("a.txt"), "w", encoding="utf-8")'),
    ('p.write_text(s)', 1, 'p.write_text(s, encoding="utf-8")'),
    ('p.write_text(s, encoding="utf-8")', 0, 'encoding="utf-8"'),
    ('p.read_text()', 1, 'p.read_text(encoding="utf-8")'),
    ('p.write_bytes(s)', 0, 'p.write_bytes(s)'),
    ('open("a.txt")', 1, 'open("a.txt", encoding="utf-8")'),  # default mode 'r'
    ('open("a.txt", mode="w")', 1, 'encoding="utf-8"'),
    ('open(path, mode_var)', 0, 'open(path, mode_var)'),  # dynamic mode, skip
    ('def open(self): pass', 0, 'def open(self): pass'),
    # multiline:
    ('with open(\n    path,\n    "w",\n) as f:', 1, 'encoding="utf-8"'),
    # triple-quoted string containing open() should NOT be patched
    ('s = """\nwith open("foo", "w") as f:\n    pass\n"""\n', 0, 'with open("foo", "w") as f:'),
    # single-line string
    ('s = "open(\\\"foo\\\", \\\"w\\\")"\n', 0, 's = "open(\\\"foo\\\", \\\"w\\\")"\n'),
    # commented code
    ('# open("foo", "w")\nopen("bar", "w")', 1, 'open("bar", "w", encoding="utf-8")'),
    # positional encoding on read_text - must NOT add another
    ('p.read_text("utf-8")', 0, 'p.read_text("utf-8")'),
    ('p.write_text(s, "utf-8")', 0, 'p.write_text(s, "utf-8")'),
    ('p.write_text(s, "utf-8", "ignore")', 0, 'p.write_text(s, "utf-8", "ignore")'),
]

for src, expected_changes, expected_sub in CASES:
    new, n = patch_call(src, predicate)
    ok = n == expected_changes and expected_sub in new
    status = "OK" if ok else "FAIL"
    print(f"[{status}] in: {src!r}")
    print(f"    out: {new!r}")
    print(f"    changes={n} expected={expected_changes} contains {expected_sub!r}: {expected_sub in new}")
