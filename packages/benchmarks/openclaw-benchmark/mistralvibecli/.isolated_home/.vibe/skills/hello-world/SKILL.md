---
name: hello-world
description: A simple hello world skill for Mistral Vibe
user-invocable: true
---

# Hello World Skill

This skill provides a simple hello world command.

## Tools

### `hello_world`

Prints a hello world message.

```python
def hello_world(name: str = "World") -> str:
    """
    Prints a hello world message.
    
    Args:
        name: The name to greet. Defaults to "World".
    """
    return f"Hello, {name}! Welcome to Mistral Vibe."
```
