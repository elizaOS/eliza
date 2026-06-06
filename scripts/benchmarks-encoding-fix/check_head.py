"""Check whether files in HEAD already had syntax errors."""
import subprocess
import ast
import sys

files = [
    "packages/benchmarks/swe-bench-pro/run_scripts/instance_element-hq__element-web-16ec3b5d7b2afe96874a9f691165a2b2cd18b398-v579cb6b03cf8f928b7694cb4f65acf55bd8b8fb8/parser.py",
    "packages/benchmarks/qwen-claw-bench/data/qwenclawbench-v1.1-100/assets/task_00090_daily_password_verification_system_design_document/scripts/generate_data.py",
]

for f in files:
    r = subprocess.run(["git", "show", f"HEAD:{f}"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(f"GIT ERROR for {f}: {r.stderr[:200]}")
        continue
    try:
        ast.parse(r.stdout)
        print(f"OK at HEAD: {f}")
    except SyntaxError as e:
        print(f"PRE-EXISTING ERROR at HEAD: {f}: {e}")
