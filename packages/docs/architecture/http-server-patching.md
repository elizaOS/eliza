# HTTP Server Patching Architecture

## Overview

Eliza patches Node.js's `http.createServer` function to inject a compatibility layer around the upstream elizaOS HTTP server. This document explains why this approach was chosen, the trade-offs involved, and the long-term solution.

## The Problem

The upstream `@elizaos/agent` package creates its own HTTP server internally using `http.createServer()` directly. It does not provide:

- Extension points for middleware
- Hooks for request/response interception
- A custom server factory parameter
- Event-based architecture for extensibility

Eliza needs to extend the upstream server to:

1. **Intercept requests** - Handle Eliza-specific compat routes (cloud auth, agent lifecycle, etc.) before they reach upstream handlers
2. **Add CORS headers** - Enable local development (Vite, WKWebView, static loopback servers)
3. **Attach WebSocket handlers** - Support local inference device-bridge WebSocket upgrades
4. **Sync environment state** - Keep Eliza and elizaOS environments in sync on each request

## The Solution: HTTP Server Patching

### Implementation

The `patchHttpCreateServerForCompat` function wraps `http.createServer` to inject a compatibility layer:

```typescript
const restore = patchHttpCreateServerForCompat(compatState);
const server = await upstreamStartApiServer(...);
// ... server lifecycle ...
restore(); // Restore original on shutdown
```

The wrapper:
1. Intercepts the listener passed to `http.createServer`
2. Adds CORS headers for local development
3. Checks compat routes before upstream routes
4. Attaches WebSocket upgrade handlers
5. Syncs environment state
6. Falls through to upstream listener if not handled

### Why This Approach

**Alternatives considered and rejected:**

1. **Proxy server** - Run upstream on one port, proxy through Eliza
   - ❌ Adds complexity, port management, latency
   - ❌ Double network hop for all requests

2. **Custom server factory** - Fork upstream to accept custom server
   - ❌ Breaks sync with upstream updates
   - ❌ Heavy maintenance burden
   - ❌ Divergent codebase

3. **Express middleware wrapper** - Wrap upstream in Express
   - ❌ Upstream uses raw Node.js HTTP, not Express
   - ❌ Would require rewriting upstream server logic

4. **HTTP server patching** (current) - Intercept `http.createServer`
   - ✅ Minimal code impact
   - ✅ Stays in sync with upstream
   - ✅ No forking required
   - ✅ Clean separation of concerns

## Risks & Mitigations

### Risk 1: Monkey-patching Node.js internals is unusual and fragile

**Mitigations:**
- Patch is scoped to server startup only, not global
- Original function is restored on shutdown via returned cleanup function
- Wrapper is well-structured with comprehensive error handling
- Patch is applied before upstream server creation, not during runtime

### Risk 2: Could conflict with other patches in the same process

**Mitigations:**
- Eliza runs as the main entry point in its process
- Minimal patch conflicts expected
- Patch is applied once and restored cleanly
- No other known patches in the Eliza runtime

### Risk 3: Node.js updates could break the patch

**Mitigations:**
- Uses standard `http.createServer` API (stable since Node.js 0.1.0)
- Patch relies on well-documented, stable interfaces
- Can be updated quickly if Node.js API changes
- Tests verify patch behavior

## Long-Term Solution

The HTTP server patching is a pragmatic workaround for upstream architectural limitations. The long-term solution is to work with the upstream elizaOS project to provide proper extension points.

### Upstream Extension Points Needed

1. **Middleware hooks** - Allow pre/post request processing
   ```typescript
   interface ApiServerOptions {
     middleware?: {
       onRequest?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
       onResponse?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
     };
   }
   ```

2. **Custom server factory** - Allow passing a custom HTTP server
   ```typescript
   interface ApiServerOptions {
     httpServer?: http.Server;
     createServer?: typeof http.createServer;
   }
   ```

3. **Event-based architecture** - Emit events for lifecycle hooks
   ```typescript
   server.on('request', (req, res) => { /* ... */ });
   server.on('upgrade', (req, socket, head) => { /* ... */ });
   ```

### Tracking

- Create upstream issue in elizaOS repository
- Engage with upstream maintainers on extension points
- Prototype alternative approaches in parallel
- Document migration path when upstream provides extension points

## References

- Implementation: `packages/app-core/src/api/server.ts`
- Compat routes: `packages/app-core/src/api/*-compat-routes.ts`
- Upstream server: `eliza/packages/agent/api/server.ts`

## Decision Record

**Date:** 2026-04-25
**Status:** Accepted
**Context:** Need to extend upstream HTTP server without forking
**Decision:** Use HTTP server patching as pragmatic workaround
**Consequences:**
- Enables Eliza to extend upstream without forking
- Unusual pattern requires documentation
- Long-term: work with upstream on proper extension points
