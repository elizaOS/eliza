#!/usr/bin/env python3
import re
import sys
from pathlib import Path

def remove_simple_docstrings(content):
    lines = content.split('\n')
    new_lines = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Match simple one-line docstrings like:        """Get something."""
        if re.match(r'^\s+"""[^"]*"""\.?$', line):
            i += 1
            continue
        new_lines.append(line)
        i += 1
    return '\n'.join(new_lines)

def process_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        new_content = remove_simple_docstrings(content)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        return True
    except Exception as e:
        print(f'Error processing {filepath}: {e}', file=sys.stderr)
        return False

if __name__ == '__main__':
    base_dir = Path(__file__).parent
    python_files = list(base_dir.rglob('*.py'))
    
    for py_file in python_files:
        if 'clean_docstrings.py' in str(py_file):
            continue
        process_file(py_file)
