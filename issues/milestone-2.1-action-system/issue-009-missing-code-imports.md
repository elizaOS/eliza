# Code Examples Missing Import Statements

## ⚠️ Priority: High

## 📋 Issue Summary

Code examples throughout the documentation are missing import statements, making them incomplete and non-functional. Developers cannot copy-paste examples and expect them to work without guessing the correct imports.

## 🐛 Problem Description

### Current State
Most code examples start directly with implementation without showing required imports:

```typescript
// Example from actions.md - missing imports
const customAction: Action = {
  name: 'CUSTOM_ACTION',
  // ... implementation
};
```

### Missing Import Categories

#### **1. Core Type Imports**
```typescript
// Missing from all Action examples:
import { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback,
  Content,
  ActionExample 
} from '@elizaos/core';
```

#### **2. Model and Utility Imports**
```typescript
// Missing from model usage examples:
import { 
  ModelType,
  composePromptFromState,
  parseJSONObjectFromText 
} from '@elizaos/core';
```

#### **3. Service Type Imports**
```typescript
// Missing from service examples:
import { ServiceType } from '@elizaos/core';
```

#### **4. Plugin Development Imports**
```typescript
// Missing from plugin examples:
import { Plugin, Service } from '@elizaos/core';
```

### Files Affected

1. **Actions Documentation**: `/packages/docs/docs/core/actions.md`
   - Basic action template (line 87)
   - REPLY action example (line 171)
   - Image generation example (line 295)

2. **Service Documentation**: `/packages/docs/docs/core/services.md`
   - Service implementation examples

3. **Plugin Documentation**: `/packages/docs/docs/core/plugins.md`
   - Plugin structure examples

4. **Character Documentation**: Archived and versioned docs
   - Character file examples

5. **Provider Documentation**: `/packages/docs/docs/core/providers.md`
   - Provider implementation examples

6. **Evaluator Documentation**: `/packages/docs/docs/core/evaluators.md`
   - Evaluator implementation examples

## ✅ Acceptance Criteria

- [ ] All TypeScript code examples include complete import statements
- [ ] Imports reference correct package locations
- [ ] Examples are self-contained and compilable
- [ ] Import statements include all referenced types and functions
- [ ] Consistent import style across all documentation
- [ ] Import comments explain package sources when helpful

## 🔧 Implementation Steps

### 1. Add Complete Imports to Action Examples

#### **Basic Action Template** (`/packages/docs/docs/core/actions.md:87`)

```typescript
import { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback,
  Content,
  ActionExample 
} from '@elizaos/core';

const customAction: Action = {
  // ... rest of implementation
};

export default customAction;
```

#### **REPLY Action Example** (`/packages/docs/docs/core/actions.md:171`)

```typescript
import { 
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  Content,
  ModelType,
  composePromptFromState,
  parseJSONObjectFromText
} from '@elizaos/core';

// Import template (typically from separate file)
import { replyTemplate } from './templates/reply';

const replyAction: Action = {
  // ... implementation
};

export default replyAction;
```

#### **Image Generation Example** (`/packages/docs/docs/core/actions.md:295`)

```typescript
import { 
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  Content,
  ServiceType,
  generateId
} from '@elizaos/core';

const generateImageAction: Action = {
  // ... implementation
};

export default generateImageAction;
```

### 2. Add Service Implementation Imports

```typescript
import { 
  Service,
  IAgentRuntime,
  ServiceDefinition,
  ServiceType
} from '@elizaos/core';

export class CustomService extends Service {
  // ... implementation
}
```

### 3. Add Provider Implementation Imports

```typescript
import { 
  Provider,
  IAgentRuntime,
  Memory,
  State
} from '@elizaos/core';

const customProvider: Provider = {
  // ... implementation
};

export default customProvider;
```

### 4. Add Evaluator Implementation Imports

```typescript
import { 
  Evaluator,
  IAgentRuntime,
  Memory,
  State
} from '@elizaos/core';

const customEvaluator: Evaluator = {
  // ... implementation
};

export default customEvaluator;
```

### 5. Add Plugin Structure Imports

```typescript
import { 
  Plugin,
  Action,
  Provider,
  Evaluator,
  Service
} from '@elizaos/core';

// Import your custom components
import { myAction } from './actions/myAction';
import { myProvider } from './providers/myProvider';
import { myEvaluator } from './evaluators/myEvaluator';
import { myService } from './services/myService';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  version: '1.0.0',
  actions: [myAction],
  providers: [myProvider],
  evaluators: [myEvaluator],
  services: [myService],
};

export default myPlugin;
```

### 6. Add Character File Imports (TypeScript)

```typescript
import { Character } from '@elizaos/core';

export const myCharacter: Character = {
  // ... character definition
};

export default myCharacter;
```

### 7. Create Import Reference Guide

Create `/packages/docs/docs/core/imports-reference.md`:

```markdown
# Import Reference Guide

## Core Types

```typescript
import { 
  // Agent and Runtime
  IAgentRuntime,
  
  // Component Types
  Action,
  Provider, 
  Evaluator,
  Service,
  Plugin,
  
  // Data Types
  Memory,
  State,
  Content,
  Character,
  
  // Callback Types
  HandlerCallback,
  
  // Example Types
  ActionExample,
  
  // Service Types
  ServiceType,
  
  // Model Types
  ModelType
} from '@elizaos/core';
```

## Utility Functions

```typescript
import {
  // Prompt Utilities
  composePromptFromState,
  
  // Parsing Utilities
  parseJSONObjectFromText,
  
  // ID Generation
  generateId,
  
  // UUID Utilities
  stringToUuid,
  validateUuid
} from '@elizaos/core';
```

## Service Registration

```typescript
import { createService, defineService } from '@elizaos/core';
```
```

## 📝 Files to Update

### Major Documentation Files
1. `/packages/docs/docs/core/actions.md` - All action examples
2. `/packages/docs/docs/core/services.md` - Service implementation examples
3. `/packages/docs/docs/core/providers.md` - Provider examples
4. `/packages/docs/docs/core/evaluators.md` - Evaluator examples
5. `/packages/docs/docs/core/plugins.md` - Plugin structure examples

### New Files to Create
1. `/packages/docs/docs/core/imports-reference.md` - Complete import guide
2. Update sidebar to include import reference

### Verification Files
1. Create test files that import and compile all documented examples
2. Add to CI/CD pipeline to validate examples

## 🧪 Testing

- [ ] Create test TypeScript files for each documented example
- [ ] Verify all imports resolve correctly from @elizaos/core
- [ ] Confirm examples compile without errors
- [ ] Test that examples work in actual ElizaOS projects
- [ ] Validate import paths match actual package exports

## 📚 Related Issues

- Issue #007: Action interface discrepancy (affects import accuracy)
- Issue #015: File path references (complements import statements)
- Issue #021: Pre-commit validation (can auto-check imports)

## 💡 Additional Context

### Import Statement Standards

1. **Grouping**: Group imports by source package
2. **Ordering**: Core types first, utilities second, specific components third
3. **Comments**: Add comments for complex or non-obvious imports
4. **Exports**: Always show export statements for reusable components

### Package Export Verification

The imports assume all documented types are exported from `@elizaos/core`. This should be verified against:
- `/packages/core/src/index.ts` - Main export file
- `/packages/core/package.json` - Package configuration
- Individual type definition files

### Developer Experience Impact

Complete imports provide:
- **Copy-paste functionality**: Examples work immediately
- **IDE support**: Better autocomplete and error checking
- **Learning**: Shows proper package organization
- **Debugging**: Clearer error messages when imports fail

### Maintenance Strategy

Consider adding:
- Automated import validation in CI/CD
- Import extraction tools that auto-generate from source
- Import consistency checks across all documentation

## 📎 Source Code References

- Core exports: `/packages/core/src/index.ts`
- Type definitions: `/packages/core/src/types/`
- Current examples: Various files in `/packages/docs/docs/core/`
- Package configuration: `/packages/core/package.json`