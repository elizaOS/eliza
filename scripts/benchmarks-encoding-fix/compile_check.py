"""Verify all patched files compile. Skip files that were already broken at HEAD."""
import ast
import sys
import subprocess
from pathlib import Path

result = subprocess.run(
    ["git", "diff", "--name-only", "--", "packages/benchmarks/"],
    capture_output=True, text=True, check=True
)
files = [f for f in result.stdout.splitlines() if f.endswith(".py")]
print(f"Checking {len(files)} modified .py files...")

bad_now: list[str] = []
for f in files:
    try:
        src = Path(f).read_text(encoding="utf-8")
        ast.parse(src, filename=f)
    except SyntaxError:
        bad_now.append(f)

print(f"\n{len(bad_now)} files have syntax errors after patching.")
print("Checking if these were already broken at HEAD...")

regressions: list[tuple[str, str]] = []
for f in bad_now:
    r = subprocess.run(
        ["git", "show", f"HEAD:{f}"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        regressions.append((f, "git error / not in HEAD"))
        continue
    try:
        ast.parse(r.stdout)
        # was OK at HEAD => regression
        regressions.append((f, "was OK at HEAD - REGRESSION"))
    except SyntaxError as e:
        # already broken at HEAD - not our fault
        pass

print(f"\n{len(regressions)} regressions caused by patching:")
for f, why in regressions:
    print(f"  {why}: {f}")

sys.exit(1 if regressions else 0)
