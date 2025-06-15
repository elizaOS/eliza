# Server Package Backward Compatibility

This document outlines the backward compatibility guarantees and migration guidance for the `@elizaos/server` package.

## Overview

The server package has been split from the CLI to enable independent usage while maintaining full backward compatibility with existing CLI integrations.

## ✅ Compatibility Guarantees

### 1. **AgentServer Class API**

The `AgentServer` class maintains the same public API that the CLI depends on:

```typescript
import { AgentServer } from '@elizaos/server';

const server = new AgentServer();

// ✅ All existing methods preserved
await server.initialize(options);
server.start(port);
await server.stop();
await server.registerAgent(runtime);
server.unregisterAgent(agentId);
server.registerMiddleware(middleware);

// ✅ Properties remain accessible
server.app;           // Express application
server.database;      // Database adapter
server.server;        // HTTP server
server.socketIO;      // Socket.IO instance
server.isInitialized; // Initialization flag
```

### 2. **Loader Function Exports**

All loader utilities are properly exported for CLI usage:

```typescript
import { 
  loadCharacterTryPath,
  jsonToCharacter,
  tryLoadFile,
  loadCharactersFromUrl,
  loadCharacter,
  hasValidRemoteUrls,
  loadCharacters
} from '@elizaos/server';

// ✅ All CLI loader patterns supported
```

### 3. **Utility Functions**

Path and configuration utilities remain available:

```typescript
import { expandTildePath, resolvePgliteDir } from '@elizaos/server';

// ✅ CLI configuration patterns preserved
const dataDir = resolvePgliteDir(customDir);
const expandedPath = expandTildePath('~/config');
```

### 4. **Type Exports**

All TypeScript interfaces are exported for type safety:

```typescript
import type { ServerOptions, ServerMiddleware } from '@elizaos/server';

// ✅ CLI type compatibility maintained
```

## 🔧 Migration Changes Made

### CLI Import Updates

The following CLI files were updated to use the server package correctly:

1. **`packages/cli/src/commands/start/actions/agent-start.ts`**
   ```diff
   - import { AgentServer } from '@/src/server/index';
   + import { AgentServer } from '@elizaos/server';
   ```

2. **`packages/cli/src/commands/start/actions/server-start.ts`**
   ```diff
   - import { jsonToCharacter, loadCharacterTryPath } from '../utils/loader';
   + import { AgentServer, jsonToCharacter, loadCharacterTryPath } from '@elizaos/server';
   ```

3. **`packages/cli/src/commands/test/actions/e2e-tests.ts`**
   ```diff
   - import { jsonToCharacter, loadCharacterTryPath } from '../../../commands/start/utils/loader';
   + import { AgentServer, jsonToCharacter, loadCharacterTryPath } from '@elizaos/server';
   ```

4. **`packages/cli/src/commands/start/index.ts`**
   ```diff
   - import { loadCharacterTryPath } from './utils/loader';
   + import { loadCharacterTryPath } from '@elizaos/server';
   ```

### Dependency Management

- CLI's `package.json` maintains `"@elizaos/server": "workspace:*"` dependency
- Server package is properly versioned and published independently
- No breaking changes to existing CLI workflows

## 🔒 CLI Usage Patterns Preserved

### 1. **Server Initialization Pattern**

```typescript
// ✅ CLI pattern continues to work
const server = new AgentServer();
await server.initialize({ dataDir: pgliteDataDir, postgresUrl });

// ✅ CLI extensions continue to work
server.startAgent = (character) => startAgent(character, server);
server.stopAgent = (runtime) => stopAgent(runtime, server);
server.loadCharacterTryPath = loadCharacterTryPath;
server.jsonToCharacter = jsonToCharacter;
```

### 2. **Agent Management Pattern**

```typescript
// ✅ CLI agent registration continues to work
await server.registerAgent(runtime);
server.unregisterAgent(agentId);
```

### 3. **Database Configuration Pattern**

```typescript
// ✅ CLI database setup continues to work
const pgliteDataDir = postgresUrl ? undefined : await resolvePgliteDir();
await server.initialize({ dataDir: pgliteDataDir, postgresUrl });
```

### 4. **Server Lifecycle Pattern**

```typescript
// ✅ CLI server startup continues to work
const serverPort = await findNextAvailablePort(desiredPort);
server.start(serverPort);
```

## 🧪 Compatibility Verification

### Automated Tests

The server package includes compatibility tests that verify:

- ✅ AgentServer class API compatibility
- ✅ Loader function exports
- ✅ Utility function exports  
- ✅ Type interface compatibility
- ✅ Error handling patterns
- ✅ Middleware registration patterns

### Manual Verification

1. **CLI Build Compatibility**: The CLI should build successfully with server package imports
2. **Runtime Compatibility**: CLI commands should execute without errors
3. **Agent Management**: Agent start/stop operations should work as expected
4. **Database Integration**: Database setup and migrations should work correctly

## 🚨 Breaking Change Policy

The server package follows semantic versioning:

- **Patch versions (x.x.X)**: Bug fixes, no breaking changes
- **Minor versions (x.X.x)**: New features, backward compatible
- **Major versions (X.x.x)**: Breaking changes, migration guide provided

## 📋 Deprecation Notice

### Duplicate Loader Functions

The CLI previously had duplicate loader functions in:
- `packages/cli/src/commands/start/utils/loader.ts`
- `packages/cli/src/server/loader.ts`

These are now deprecated in favor of the server package exports. The CLI has been updated to use the server package versions.

## 🔄 Migration Guide for External Users

If you're using the server package externally and were previously importing from CLI paths:

### Before (❌ Deprecated)
```typescript
import { AgentServer } from '@elizaos/cli/dist/server';
```

### After (✅ Recommended)
```typescript
import { AgentServer } from '@elizaos/server';
```

## 🛠️ Development Considerations

### 1. **Workspace Dependencies**

Both packages use workspace dependencies for development:
```json
{
  "dependencies": {
    "@elizaos/server": "workspace:*"
  }
}
```

### 2. **Build Order**

The server package should be built before the CLI:
```bash
# Correct build order
npm run build --workspace=@elizaos/server
npm run build --workspace=@elizaos/cli
```

### 3. **Testing Integration**

Integration tests should verify CLI + server combinations work correctly.

## 📞 Support

For compatibility issues or migration questions:

1. Check this compatibility documentation
2. Review the test suites for usage examples
3. Create an issue with compatibility details
4. Include version information for both packages

## 🎯 Future Compatibility

The server package is designed for:

- ✅ **Independent usage** - Can be used without CLI
- ✅ **CLI integration** - Maintains full CLI compatibility  
- ✅ **Extension patterns** - Supports CLI's extension mechanisms
- ✅ **Version flexibility** - Can evolve independently while maintaining compatibility