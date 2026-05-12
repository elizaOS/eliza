---
name: fuzzy-match
description: A toolkit for fuzzy string matching and data reconciliation. Useful for matching entity names (companies, people) across different datasets where spelling variations, typos, or formatting differences exist.
license: MIT
---

# Fuzzy Matching Guide

## Overview

This skill provides methods to compare strings and find the best matches using Levenshtein distance and other similarity metrics. It is essential when joining datasets on string keys that are not identical.

## Quick Start

```python
from difflib import SequenceMatcher

def similarity(a, b):
    return SequenceMatcher(None, a, b).ratio()

print(similarity("Apple Inc.", "Apple Incorporated"))
# Output: 0.7...
```

## Python Libraries

### difflib (Standard Library)

The `difflib` module provides classes and functions for comparing sequences.

#### Basic Similarity

```python
from difflib import SequenceMatcher

def get_similarity(str1, str2):
    """Returns a ratio between 0 and 1."""
    return SequenceMatcher(None, str1, str2).ratio()

# Example
s1 = "Acme Corp"
s2 = "Acme Corporation"
print(f"Similarity: {get_similarity(s1, s2)}")
```

#### Finding Best Match in a List

```python
from difflib import get_close_matches

word = "appel"
possibilities = ["ape", "apple", "peach", "puppy"]
matches = get_close_matches(word, possibilities, n=1, cutoff=0.6)
print(matches)
# Output: ['apple']
```

### rapidfuzz (Recommended for Performance)

If `rapidfuzz` is available (pip install rapidfuzz), it is much faster and offers more metrics.

```python
from rapidfuzz import fuzz, process

# Simple Ratio
score = fuzz.ratio("this is a test", "this is a test!")
print(score)

# Partial Ratio (good for substrings)
score = fuzz.partial_ratio("this is a test", "this is a test!")
print(score)

# Extraction
choices = ["Atlanta Falcons", "New York Jets", "New York Giants", "Dallas Cowboys"]
best_match = process.extractOne("new york jets", choices)
print(best_match)
# Output: ('New York Jets', 100.0, 1)
```

## Common Patterns

### Normalization before Matching

Always normalize strings before comparing to improve accuracy.

```python
import re

def normalize(text):
    # Convert to lowercase
    text = text.lower()
    # Remove special characters
    text = re.sub(r'[^\w\s]', '', text)
    # Normalize whitespace
    text = " ".join(text.split())
    # Common abbreviations
    text = text.replace("limited", "ltd").replace("corporation", "corp")
    return text

s1 = "Acme  Corporation, Inc."
s2 = "acme corp inc"
print(normalize(s1) == normalize(s2))
```

### Entity Resolution

When matching a list of dirty names to a clean database:

```python
clean_names = ["Google LLC", "Microsoft Corp", "Apple Inc"]
dirty_names = ["google", "Microsft", "Apple"]

results = {}
for dirty in dirty_names:
    # simple containment check first
    match = None
    for clean in clean_names:
        if dirty.lower() in clean.lower():
            match = clean
            break

    # fallback to fuzzy
    if not match:
        matches = get_close_matches(dirty, clean_names, n=1, cutoff=0.6)
        if matches:
            match = matches[0]

    results[dirty] = match
```
