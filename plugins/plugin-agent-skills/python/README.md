# Agent Skills Plugin for elizaOS (Python)

Implements the Agent Skills specification with:
- Spec-compliant SKILL.md parsing and validation
- Progressive disclosure (metadata → instructions → resources)
- ClawHub registry integration
- Otto metadata compatibility
- Dual storage modes (memory/filesystem)

## Installation

```bash
pip install elizaos-plugin-agent-skills
```

For development:

```bash
pip install -e ".[dev]"
```

## Usage

### Basic Parsing

```python
from elizaos_plugin_agent_skills import parse_frontmatter, validate_frontmatter

content = """---
name: my-skill
description: A helpful skill for doing things
---
# My Skill

Instructions here.
"""

result = parse_frontmatter(content)
frontmatter = result["frontmatter"]
body = result["body"]

# Validate
validation = validate_frontmatter(frontmatter, "my-skill")
if validation["valid"]:
    print(f"Skill: {frontmatter['name']}")
```

### Storage (Memory vs Filesystem)

```python
from elizaos_plugin_agent_skills import (
    MemorySkillStore,
    FileSystemSkillStore,
    load_skill_from_storage,
    install_from_github,
)

# Memory storage (browser/virtual FS)
store = MemorySkillStore("/virtual/skills")
await store.initialize()

# Load from content
await store.load_from_content("my-skill", skill_md_content)

# Or from GitHub
skill = await install_from_github(store, "owner/repo", path="skills/my-skill")

# Load skill
skill = await load_skill_from_storage(store, "my-skill")
print(f"Loaded: {skill['name']}")
```

### Generate XML for Agent Prompts

```python
from elizaos_plugin_agent_skills import generate_skills_xml

skills = [
    {"name": "skill-one", "description": "First skill", "location": "/path/to/skill"},
    {"name": "skill-two", "description": "Second skill", "location": "/path/to/skill"},
]

xml = generate_skills_xml(skills, include_location=True)
print(xml)
```

## Testing

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# With Anthropic integration tests
ANTHROPIC_API_KEY=your-key pytest
```

## Specification

See: https://agentskills.io
