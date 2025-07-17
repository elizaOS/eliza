# EventEmitter Compatibility Tests

This directory contains unit tests that verify EventEmitter compatibility for EventTarget-based implementations in the ElizaOS codebase.

## Overview

Per the CLAUDE.md guidelines, ElizaOS uses Bun's native `EventTarget` API instead of Node.js's `EventEmitter` for better compatibility and performance. However, to maintain backward compatibility with existing code that expects EventEmitter-like APIs, we provide compatibility layers.

## Test Files

### bus-eventemitter-compatibility.test.ts

Tests the EventEmitter compatibility of the internal message bus (`/packages/server/src/bus.ts`).

Key test areas:

- `emit()` method functionality
- `on()` method for adding listeners
- `off()` method for removing listeners
- `setMaxListeners()` compatibility method
- Event ordering and error handling
- Memory management and performance

### simple-migration-agent-eventemitter-compatibility.test.ts

Tests the EventEmitter compatibility of the SimpleMigrationAgent (`/packages/cli/src/utils/upgrade/simple-migration-agent.ts`).

Additional test areas:

- `removeListener()` alias method
- `removeAllListeners()` method
- `listenerCount()` method
- `listeners()` method
- Integration with migration lifecycle events

## Implementation Pattern

The EventEmitter compatibility pattern used in ElizaOS:

```typescript
class MyClass extends EventTarget {
  private handlers = new Map<string, Map<Function, EventListener>>();

  emit(event: string, data: any) {
    return this.dispatchEvent(new CustomEvent(event, { detail: data }));
  }

  on(event: string, handler: (data: any) => void) {
    const wrappedHandler = ((e: CustomEvent) => handler(e.detail)) as EventListener;
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Map());
    }
    this.handlers.get(event)!.set(handler, wrappedHandler);
    this.addEventListener(event, wrappedHandler);
    return this;
  }

  off(event: string, handler: (data: any) => void) {
    const eventHandlers = this.handlers.get(event);
    const wrappedHandler = eventHandlers?.get(handler);
    if (wrappedHandler) {
      this.removeEventListener(event, wrappedHandler);
      eventHandlers!.delete(handler);
      if (eventHandlers!.size === 0) {
        this.handlers.delete(event);
      }
    }
  }
}
```

## Key Differences from EventEmitter

1. **Undefined handling**: CustomEvent converts `undefined` detail to `null`
2. **Error propagation**: EventTarget propagates errors to window/global error handler
3. **No built-in max listeners**: `setMaxListeners()` is provided for API compatibility only
4. **Method chaining**: `on()` returns `this` for compatibility

## Running the Tests

```bash
# Run bus compatibility tests
bun test packages/server/src/__tests__/bus-eventemitter-compatibility.test.ts

# Run SimpleMigrationAgent compatibility tests
bun test packages/cli/tests/unit/utils/simple-migration-agent-eventemitter-compatibility.test.ts

# Run all server tests
cd packages/server && bun test

# Run all CLI tests
cd packages/cli && bun test
```

## Test Coverage

Both test suites achieve comprehensive coverage of the EventEmitter-like API:

- All public methods are tested
- Edge cases like duplicate handlers, non-existent handlers
- Memory management and cleanup
- Performance with many listeners
- Complex data type handling
- Event ordering guarantees
