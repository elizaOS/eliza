# Maestro Utilities

This directory contains various utility functions for the Maestro project to improve code reusability and maintainability.

## File Structure

```
gui_agents/utils/
├── README.md           # This document
├── file_utils.py       # File operation utilities
├── id_utils.py         # ID generation utilities
└── common_utils.py     # Other common utilities
```

## file_utils.py - File Operation Utilities

### File Locking Mechanism

```python
from gui_agents.utils.file_utils import locked

# Cross-platform file lock, supports Windows and Unix systems
with locked(file_path, "w") as f:
    f.write("content")
```

### Safe JSON Operations

```python
from gui_agents.utils.file_utils import safe_write_json, safe_read_json

# Safely write JSON file (atomic operation)
safe_write_json(file_path, data)

# Safely read JSON file
data = safe_read_json(file_path, default={})
```

### Safe Text Operations

```python
from gui_agents.utils.file_utils import safe_write_text, safe_read_text

# Safely write text file (UTF-8 encoding)
safe_write_text(file_path, content)

# Safely read text file (automatic encoding detection)
content = safe_read_text(file_path)
```

### File Management Tools

```python
from gui_agents.utils.file_utils import ensure_directory, backup_file

# Ensure directory exists
ensure_directory(path)

# Create file backup
backup_path = backup_file(file_path, ".backup")
```

## id_utils.py - ID Generation Utilities

### UUID Generation

```python
from gui_agents.utils.id_utils import generate_uuid, generate_short_id

# Generate complete UUID
uuid_str = generate_uuid()  # "550e8400-e29b-41d4-a716-446655440000"

# Generate short ID
short_id = generate_short_id("task", 8)  # "task550e8400"
```

### Timestamp ID

```python
from gui_agents.utils.id_utils import generate_timestamp_id

# Timestamp-based ID
ts_id = generate_timestamp_id("event")  # "event1755576661494"
```

### Hash ID

```python
from gui_agents.utils.id_utils import generate_hash_id

# Content hash-based ID
hash_id = generate_hash_id("some content", "hash", 8)  # "hasha1b2c3d4"
```

### Composite ID

```python
from gui_agents.utils.id_utils import generate_composite_id

# Composite ID (prefix + timestamp + UUID)
composite_id = generate_composite_id("task", True, True, "_")  # "task_1755576661494_550e8400"
```

## Usage in NewGlobalState

The new `NewGlobalState` class has been refactored to use these utility functions:

```python
from gui_agents.utils.file_utils import safe_write_json, safe_read_json
from gui_agents.utils.id_utils import generate_uuid

class NewGlobalState:
    def __init__(self, ...):
        self.task_id = task_id or f"task-{generate_uuid()[:8]}"
    
    def set_task(self, task_data):
        safe_write_json(self.task_path, task_data)
    
    def get_task(self):
        return safe_read_json(self.task_path, {})
```
