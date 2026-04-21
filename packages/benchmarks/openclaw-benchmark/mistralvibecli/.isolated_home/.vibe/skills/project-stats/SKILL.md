---
name: project-stats
description: Generates statistics about the current project (lines of code, file types).
user-invocable: true
---

# Project Statistics Skill

To generate project statistics, please use the `bash` tool to run the following Python script.
Do NOT attempt to call a `project_stats` function directly. Instead, write this script to a temporary file (e.g., `_project_stats.py`) and execute it.

```python
import os
import sys
from pathlib import Path
from collections import defaultdict

def analyze_project(root_path: Path):
    stats = defaultdict(lambda: {"files": 0, "lines": 0})
    total_files = 0
    total_lines = 0

    print(f"Analyzing project at: {root_path}")
    print("-" * 40)

    for root, dirs, files in os.walk(root_path):
        # Skip hidden directories and common build artifacts
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['node_modules', 'venv', 'target', 'build', 'dist', '__pycache__']]
        
        for file in files:
            file_path = Path(root) / file
            if file.startswith('.'):
                continue
                
            ext = file_path.suffix.lower() or "no-extension"
            
            try:
                line_count = 0
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    line_count = sum(1 for _ in f)
                
                stats[ext]["files"] += 1
                stats[ext]["lines"] += line_count
                total_files += 1
                total_lines += line_count
            except Exception:
                continue

    print(f"{'Extension':<15} | {'Files':<10} | {'Lines':<10}")
    print("-" * 40)
    
    sorted_stats = sorted(stats.items(), key=lambda x: x[1]["lines"], reverse=True)
    
    for ext, data in sorted_stats:
        print(f"{ext:<15} | {data['files']:<10} | {data['lines']:<10}")
        
    print("-" * 40)
    print(f"{'TOTAL':<15} | {total_files:<10} | {total_lines:<10}")

if __name__ == "__main__":
    analyze_project(Path.cwd())
```
