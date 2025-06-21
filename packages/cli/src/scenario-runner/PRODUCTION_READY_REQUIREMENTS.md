# Production Ready Requirements for Scenario Runner

## Current State: NOT PRODUCTION READY ❌

The scenario runner is currently a collection of stubs, placeholders, and broken abstractions. It needs a complete rewrite.

## Required Fixes

### 1. **Implement Real Multi-Agent Support**
- [ ] Create actual isolated runtime instances for each agent
- [ ] Each agent needs its own:
  - Memory store
  - Message queue
  - Service instances
  - State management
- [ ] Remove the broken `agents` Map approach
- [ ] Implement proper agent lifecycle management

### 2. **Fix Action Execution**
- [ ] Replace the stub `executeActorAction` with real implementation
- [ ] Actually find and execute actions from the runtime
- [ ] Handle action validation properly
- [ ] Track action results and side effects
- [ ] Implement proper error handling for failed actions

### 3. **Implement Assertion Validation**
- [ ] Replace the stub `validateAssertion` with real implementation
- [ ] Support different assertion types:
  - Message content assertions
  - State assertions
  - Action execution assertions
  - Timing assertions
- [ ] Track assertion results in the scenario result

### 4. **Remove Hardcoded Delays**
- [ ] Replace arbitrary `setTimeout` calls with proper event-driven architecture
- [ ] Use promises and event emitters for synchronization
- [ ] Implement proper message acknowledgment
- [ ] Add configurable timeouts where needed

### 5. **Fix Message Routing**
- [ ] Simplify the convoluted message routing logic
- [ ] Remove nested promise callbacks
- [ ] Implement proper message bus architecture
- [ ] Add message delivery guarantees

### 6. **Add Error Recovery**
- [ ] Don't stop entire actor scripts on single errors
- [ ] Implement retry logic for transient failures
- [ ] Add error boundaries for each step
- [ ] Collect and report all errors at the end

### 7. **Remove Wasteful LLM Usage**
- [ ] Replace LLM room type mapping with simple logic:
  ```typescript
  switch(roomType) {
    case 'dm': return ChannelType.DM;
    case 'group': 
    default: return ChannelType.GROUP;
  }
  ```

### 8. **Implement Proper Teardown**
- [ ] Clean up all agent instances
- [ ] Stop all services
- [ ] Clear message queues
- [ ] Release memory
- [ ] Close any open connections

### 9. **Fix Runtime Method Calls**
- [ ] Remove calls to non-existent methods like `ensureWorldExists`
- [ ] Use only methods that exist on IAgentRuntime
- [ ] Or extend the runtime interface properly

### 10. **Add Type Safety**
- [ ] Remove all `any` types
- [ ] Add proper type definitions
- [ ] Remove unsafe type assertions
- [ ] Use generics where appropriate

### 11. **Remove Dead Code**
- [ ] Remove the disconnected `run()` method
- [ ] Remove unused properties
- [ ] Clean up commented code
- [ ] Remove placeholder methods

### 12. **Implement Real Agent Isolation**
- [ ] Don't use `Object.create()` for "isolation"
- [ ] Create actual separate runtime instances
- [ ] Implement proper memory isolation
- [ ] Add service isolation

### 13. **Fix Memory Leaks**
- [ ] Implement message cleanup
- [ ] Add memory limits
- [ ] Implement circular buffer for messages
- [ ] Add garbage collection for old data

### 14. **Integrate Verification Properly**
- [ ] Use verification results in pass/fail determination
- [ ] Add verification metrics to results
- [ ] Support custom verification rules
- [ ] Add verification reporting

### 15. **Replace Fake Systems**
- [ ] Remove or reimplement ProductionVerificationSystem
- [ ] Add real integration tests
- [ ] Implement actual benchmarking
- [ ] Add performance monitoring

## Minimum Viable Implementation

For a truly production-ready scenario runner, at minimum we need:

1. **Working Actions**: Actions must actually execute
2. **Real Multi-Agent**: Each agent must have isolated state
3. **Proper Async**: No hardcoded delays, use events
4. **Error Handling**: Graceful degradation, not crashes
5. **Type Safety**: No `any` types or unsafe casts
6. **Memory Management**: No leaks, proper cleanup
7. **Real Verification**: Assertions that actually validate

## Recommended Approach

Given the current state, I recommend:

1. **Start Fresh**: The current code is too broken to fix incrementally
2. **Design First**: Create proper architecture diagrams
3. **Test Driven**: Write tests for each component first
4. **Incremental**: Build one feature at a time, fully working
5. **Type Safe**: Use TypeScript strictly from the start
6. **Document**: Add inline documentation as you go

## Conclusion

The scenario runner in its current state is **not usable** for any production purpose. It's a collection of stubs and broken abstractions that would fail immediately in any real usage. A complete rewrite following proper software engineering practices is required. 