---
name: yaml-config
description: Use this skill when reading or writing YAML configuration files, loading vehicle parameters, or handling config file parsing with proper error handling.
---

# YAML Configuration Files

## Reading YAML

Always use `safe_load` to prevent code execution vulnerabilities:

```python
import yaml

with open('config.yaml', 'r') as f:
    config = yaml.safe_load(f)

# Access nested values
value = config['section']['key']
```

## Writing YAML

```python
import yaml

data = {
    'settings': {
        'param1': 1.5,
        'param2': 0.1
    }
}

with open('output.yaml', 'w') as f:
    yaml.dump(data, f, default_flow_style=False, sort_keys=False)
```

## Options

- `default_flow_style=False`: Use block style (readable)
- `sort_keys=False`: Preserve insertion order
- `allow_unicode=True`: Support unicode characters

## Error Handling

```python
import yaml

try:
    with open('config.yaml', 'r') as f:
        config = yaml.safe_load(f)
except FileNotFoundError:
    config = {}  # Use defaults
except yaml.YAMLError as e:
    print(f"YAML parse error: {e}")
    config = {}
```

## Optional Config Loading

```python
import os
import yaml

def load_config(filepath, defaults=None):
    """Load config file, return defaults if missing."""
    if defaults is None:
        defaults = {}

    if not os.path.exists(filepath):
        return defaults

    with open(filepath, 'r') as f:
        loaded = yaml.safe_load(f) or {}

    # Merge loaded values over defaults
    result = defaults.copy()
    result.update(loaded)
    return result
```
