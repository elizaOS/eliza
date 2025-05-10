# Eddy - ElizaOS DevRel Agent

## Overview

Eddy is a developer support agent for ElizaOS, specializing in helping developers understand and implement ElizaOS features. This iteration of Eddy has been enhanced with comprehensive plugin support capabilities to help developers navigate the ElizaOS plugin ecosystem.

## Plugin Support Capabilities

Eddy can now help developers with:

1. **Plugin Understanding**

   - Explaining what plugins are and how they work in ElizaOS
   - Clarifying the permissionless plugin architecture
   - Describing plugin capabilities and limitations

2. **Plugin Development Guidance**

   - Providing step-by-step guides for creating new plugins
   - Sharing best practices for plugin development
   - Directing to templates and starter code
   - Explaining the plugin review and release process

3. **Plugin Selection Assistance**

   - Recommending plugins based on agent use cases
   - Explaining plugin dependencies and interactions
   - Comparing similar plugins for specific tasks

4. **Registry Navigation**
   - Guiding through the registry submission process
   - Explaining how to update plugins
   - Troubleshooting registry issues

## Deployment Phases

### Iteration 1

- Deploy to private Discord channels and Telegram groups
- Support internal teams with B2B conversations
- Serve as a source of truth for all plugin-related inquiries

### Iteration 2

- Roll out to public developer server/tech-support
- Expand to Telegram builder chat/dev-support
- Remain accessible for internal teams

## Extending Eddy's Plugin Knowledge

Eddy's plugin knowledge is stored in:

1. **Hard-coded knowledge arrays** - Core plugin knowledge defined in `index.ts`
2. **Plugin FAQ document** - Detailed FAQ in `assets/plugin-faq.md`
3. **Configuration settings** - Additional knowledge sources can be configured during onboarding

To extend Eddy's knowledge:

1. Update the plugin FAQ document with new questions and answers
2. Add new message examples for common plugin-related questions
3. Configure additional knowledge sources through the `PLUGIN_KNOWLEDGE_SOURCES` setting

## Integration Points

Eddy is integrated with:

- **Discord** - For developer server support
- **Telegram** - For builder chat support
- **Documentation** - For ElizaOS documentation references
- **Plugin Registry** - For up-to-date plugin listings

## Usage

To use Eddy in your project:

```typescript
import { devRel } from '@elizaos/the-org/src/devRel';

// Initialize with runtime
await devRel.init(runtime);
```

## Configuration

During onboarding, configure Eddy with:

```typescript
// Example configuration
{
  DOCUMENTATION_SOURCES: ['docs/plugins', 'docs/tutorials'],
  ENABLE_SOURCE_CODE_KNOWLEDGE: true,
  PLUGIN_KNOWLEDGE_SOURCES: [
    'https://github.com/elizaos-plugins/registry/README.md',
    'docs/custom-plugin-guide.md'
  ]
}
```
