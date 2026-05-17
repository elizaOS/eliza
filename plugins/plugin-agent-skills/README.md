# Agent Skills Plugin for elizaOS

Implements the [Agent Skills specification](https://agentskills.io) with support for:
- Spec-compliant SKILL.md parsing and validation
- Progressive disclosure (metadata → instructions → resources)
- ClawHub registry integration for skill discovery
- Otto metadata compatibility for dependency management
- **Dual storage modes**: Memory (browser/virtual FS) and Filesystem (Node.js/native)

## Installation

```bash
npm install @elizaos/plugin-agent-skills
```

## Quick Start

```typescript
import { agentSkillsPlugin } from '@elizaos/plugin-agent-skills';

// Add to your agent's plugins
const agent = createAgent({
  plugins: [agentSkillsPlugin],
  // ...
});
```

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `SKILLS_DIR` | Directory to load/install skills | `./skills` |
| `SKILLS_AUTO_LOAD` | Load installed skills on startup | `true` |
| `SKILLS_REGISTRY` | Skill registry URL | `https://clawhub.ai` |
| `SKILLS_STORAGE_TYPE` | Storage mode: `memory`, `filesystem`, or `auto` | `auto` |

## Storage Modes

The plugin supports two storage backends for maximum flexibility:

### Memory Storage (Browser/Virtual FS)

Skills are stored entirely in memory. Use this for:
- Browser environments without filesystem access
- Virtual FS scenarios (sandboxed environments)
- Ephemeral skill loading
- Testing

```typescript
import { AgentSkillsService, MemorySkillStore } from '@elizaos/plugin-agent-skills';

// Create with explicit memory storage
const service = await AgentSkillsService.start(runtime, {
  storageType: 'memory',
});

// Or use the store directly
const store = new MemorySkillStore('/virtual/skills');
await store.initialize();

// Load skills from content (no filesystem required)
await store.loadFromContent('my-skill', skillMdContent, additionalFiles);

// Load skills from downloaded zip
await store.loadFromZip('github', zipBuffer);
```

### Filesystem Storage (Node.js/Native)

Skills are stored on disk. Use this for:
- Node.js server environments
- CLI tools
- Persistent skill installations

```typescript
import { AgentSkillsService, FileSystemSkillStore } from '@elizaos/plugin-agent-skills';

// Create with explicit filesystem storage
const service = await AgentSkillsService.start(runtime, {
  storageType: 'filesystem',
  skillsDir: './my-skills',
});

// Or use the store directly
const store = new FileSystemSkillStore('./skills');
await store.initialize();
```

### Auto Detection

By default (`storageType: 'auto'`), the plugin detects the environment:
- Browser environments → Memory storage
- Node.js environments → Filesystem storage

```typescript
import { createStorage } from '@elizaos/plugin-agent-skills';

// Auto-detect based on environment
const storage = createStorage({ type: 'auto', basePath: './skills' });
```

### Transferring Skills Between Stores

Skills can be transferred between storage backends:

```typescript
import { MemorySkillStore, FileSystemSkillStore, loadSkillFromStorage } from '@elizaos/plugin-agent-skills';

// Load from filesystem
const fsStore = new FileSystemSkillStore('./skills');
await fsStore.initialize();
const content = await fsStore.loadSkillContent('my-skill');

// Transfer to memory
const memStore = new MemorySkillStore();
await memStore.initialize();
await memStore.loadFromContent('my-skill', content);

// Use skill
const skill = await loadSkillFromStorage(memStore, 'my-skill');
```

## Progressive Disclosure

The plugin implements progressive disclosure for efficient context management:

### Level 1: Metadata (~100 tokens per skill)
Skill name and description are always available in the system prompt.

```xml
<available_skills>
  <skill>
    <name>pdf-processing</name>
    <description>Extract text and tables from PDF files.</description>
    <location>/path/to/skills/pdf-processing/SKILL.md</location>
  </skill>
</available_skills>
```

### Level 2: Instructions (<5k tokens)
Full SKILL.md body loaded when a skill is triggered.

### Level 3: Resources (unlimited)
Scripts, references, and assets loaded on-demand without entering context.

## Skill Structure

```
my-skill/
├── SKILL.md          # Required: instructions + metadata
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
└── assets/           # Optional: templates, resources
```

### SKILL.md Format

```yaml
---
name: my-skill
description: What this skill does and when to use it.
license: MIT
compatibility: Requires Python 3.10+
metadata:
  author: my-org
  version: "1.0"
  otto:
    emoji: "🔧"
    requires:
      bins: ["my-cli"]
    install:
      - id: brew
        kind: brew
        formula: my-tool
        bins: ["my-cli"]
        label: "Install my-tool (brew)"
---

# My Skill

Instructions here...
```

## Actions

### USE_SKILL
Canonical entry point for invoking an enabled skill. Dispatches to the skill's bundled script or returns its SKILL.md guidance based on `mode`. Listed similes (`RUN_SKILL`, `INVOKE_SKILL`, `EXECUTE_SKILL`, `CALL_SKILL`) absorb older inbound callers.

### SKILL
Catalog management parent action. Use `op=search`, `op=details`, `op=sync`, `op=toggle`, `op=install`, or `op=uninstall`.

## Providers

### agent_skills (Medium Resolution)
Lists installed skills with descriptions. Default provider.

### agent_skill_instructions (High Resolution)
Provides full instructions for contextually matched skills.

### agent_skills_catalog (Dynamic)
Shows available skill categories when user asks about capabilities.

## Otto Compatibility

The plugin supports Otto's extended metadata format for dependency management:

```yaml
metadata:
  otto:
    emoji: "🐙"
    requires:
      bins: ["gh"]
    install:
      - id: brew
        kind: brew
        formula: gh
        bins: ["gh"]
        label: "Install GitHub CLI (brew)"
      - id: apt
        kind: apt
        package: gh
        bins: ["gh"]
        label: "Install GitHub CLI (apt)"
```

## API Reference

### Service

```typescript
import { AgentSkillsService } from '@elizaos/plugin-agent-skills';

// Get loaded skills
const skills = service.getLoadedSkills();

// Get skill instructions
const instructions = service.getSkillInstructions('my-skill');

// Read a reference file
const content = await service.readReference('my-skill', 'api-docs.md');

// Install a skill from registry
await service.install('pdf-processing');

// Check storage mode
if (service.isMemoryMode()) {
  // Load skill from content (memory mode only)
  await service.loadSkillFromContent('custom-skill', skillMdContent);
}
```

### Storage

```typescript
import {
  MemorySkillStore,
  FileSystemSkillStore,
  createStorage,
  loadSkillFromStorage,
  type ISkillStorage,
} from '@elizaos/plugin-agent-skills';

// Create storage (auto-detects environment)
const storage = createStorage({ type: 'auto', basePath: './skills' });
await storage.initialize();

// List installed skills
const slugs = await storage.listSkills();

// Load skill content
const content = await storage.loadSkillContent('my-skill');

// Load skill into a Skill object
const skill = await loadSkillFromStorage(storage, 'my-skill');

// Memory-specific: load from content
if (storage.type === 'memory') {
  await (storage as MemorySkillStore).loadFromContent('new-skill', content);
}

// Memory-specific: load from zip
if (storage.type === 'memory') {
  await (storage as MemorySkillStore).loadFromZip('downloaded-skill', zipBuffer);
}
```

### Parser Utilities

```typescript
import {
  parseFrontmatter,
  validateFrontmatter,
  generateSkillsXml,
} from '@elizaos/plugin-agent-skills';

// Parse SKILL.md content
const { frontmatter, body } = parseFrontmatter(content);

// Validate frontmatter
const result = validateFrontmatter(frontmatter, 'skill-name');

// Generate XML for prompts
const xml = generateSkillsXml(skills, { includeLocation: true });
```

## Testing

The plugin includes comprehensive tests across TypeScript, Python, and Rust implementations.

### Run Tests (Without API Key)

```bash
# TypeScript - from monorepo root
bun run --filter @elizaos/plugin-agent-skills test
# TypeScript
ANTHROPIC_API_KEY=your-key bun run --filter @elizaos/plugin-agent-skills test
