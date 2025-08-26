# Linear Ticket: ELIZA-669 - Implement Dynamic Prompting (Multi-Turn Conversations) in ElizaOS Scenarios

## Ticket Details

**Title**: Implement Dynamic Prompting (Multi-Turn Conversations) in ElizaOS Scenarios  
**Team**: elizaOS  
**Priority**: High  
**Labels**: Feature, CLI, V2, Design  
**Status**: Todo  

## Description

# Dynamic Prompting Implementation for ElizaOS Scenarios

## Overview

Implement **Dynamic Prompting** (multi-turn conversations) in ElizaOS scenarios to enable sophisticated testing of agent behavior through extended conversations where an LLM simulates realistic user responses. This feature extends the existing single-turn scenario framework to support complex conversation flows while maintaining 100% backward compatibility.

## Problem Statement

Current ElizaOS scenarios are limited to single-turn interactions, making it impossible to test:

* **Multi-step problem solving** - Complex issues requiring multiple exchanges
* **Context retention across conversation turns** - Agent memory and awareness
* **Clarification and follow-up question handling** - Natural conversation flow
* **Error recovery and correction flows** - Agent adaptability to misunderstandings
* **Emotional intelligence** - Handling frustrated, confused, or angry users
* **Escalation decision making** - When to escalate vs. continue troubleshooting
* **Knowledge transfer effectiveness** - Teaching complex concepts over multiple turns
* **Conversation coherence** - Maintaining logical flow across extended interactions

## Solution Architecture

### Current vs. Extended Architecture

**Current Single-Turn Flow:**
```
User Input → Agent Processing → Agent Response → Evaluation
```

**New Multi-Turn Flow:**
```
Initial Input → Agent Response → LLM Simulator → Generated Response → Agent Response → Continue or Evaluate
```

## Key Requirements

### 1. Backward Compatibility
- **100% backward compatible** - all existing scenarios must work unchanged
- Gradual adoption path for teams to enhance existing scenarios
- No breaking changes to existing APIs or CLI commands

### 2. Core Components

#### Schema Extensions
- Extend `RunStepSchema` with optional `conversation` field
- Add new evaluation types: `conversation_length`, `conversation_flow`, `user_satisfaction`, `context_retention`
- Support conversation configuration with user simulator settings

#### User Simulator
- LLM-based response generation with persona-driven prompts
- Configurable personality, objectives, constraints, and knowledge level
- Realistic conversation progression based on agent responses

#### Conversation Manager
- Multi-turn execution orchestration
- Termination condition checking (satisfaction, solution provided, escalation needed)
- Turn-level and final evaluation support
- Conversation transcript generation

#### New Evaluators
- **Conversation Length**: Validate optimal conversation duration
- **Conversation Flow**: Detect required conversation patterns
- **User Satisfaction**: Measure user satisfaction through sentiment analysis
- **Context Retention**: Verify agent memory across conversation turns

## Implementation Plan

### Phase 1: Core Infrastructure (Weeks 1-2)

**Week 1: Schema and Types**
- [ ] Add `ConversationConfigSchema` to `packages/cli/src/commands/scenario/src/schema.ts`
- [ ] Extend `RunStepSchema` with optional `conversation` field
- [ ] Add new evaluation type schemas
- [ ] Create comprehensive TypeScript interfaces in `conversation-types.ts`
- [ ] Write schema validation tests
- [ ] Update existing schema tests to ensure backward compatibility

**Week 2: User Simulator**
- [ ] Implement `UserSimulator` class
- [ ] Add persona-driven prompt building with configurable parameters
- [ ] Implement constraint handling and behavioral rules
- [ ] Add conversation history management and context building
- [ ] Create comprehensive unit tests
- [ ] Integration test with actual LLM using mock scenarios

### Phase 2: Conversation Management (Weeks 3-4)

**Week 3: ConversationManager**
- [ ] Implement `ConversationManager` class
- [ ] Add turn execution logic reusing existing `askAgentViaApi` infrastructure
- [ ] Implement termination condition checking with multiple strategies
- [ ] Add conversation result aggregation and transcript generation
- [ ] Create comprehensive unit tests
- [ ] Add error handling and timeout mechanisms

**Week 4: Provider Integration**
- [ ] Modify `LocalEnvironmentProvider` to detect and handle conversation steps
- [ ] Integrate `ConversationManager` with existing provider flow
- [ ] Update `E2BEnvironmentProvider` for cloud environment support
- [ ] Maintain backward compatibility for single-turn scenarios
- [ ] Add provider-level conversation tests
- [ ] Test both single-turn and multi-turn scenarios in same test suite

### Phase 3: Evaluation System (Weeks 5-6)

**Week 5: Conversation Evaluators**
- [ ] Implement `ConversationLengthEvaluator` with configurable thresholds
- [ ] Implement `ConversationFlowEvaluator` with pattern detection
- [ ] Implement `UserSatisfactionEvaluator` with multiple measurement methods
- [ ] Implement `ContextRetentionEvaluator` with memory testing
- [ ] Add evaluator registration to `EvaluationEngine`
- [ ] Create comprehensive tests for each evaluator

**Week 6: Integration and Testing**
- [ ] Register new evaluators in `EvaluationEngine`
- [ ] Add end-to-end conversation scenario tests
- [ ] Test matrix integration with conversation parameters
- [ ] Performance testing and optimization
- [ ] Memory usage analysis and optimization
- [ ] LLM API usage optimization and rate limiting

### Phase 4: Polish and Documentation (Week 7)

**Week 7: Final Implementation**
- [ ] Create comprehensive example scenarios in `examples/` directory
- [ ] Add migration guide for existing scenarios
- [ ] Update CLI help text and documentation
- [ ] Performance optimizations and resource management
- [ ] Final integration testing with existing scenario suite
- [ ] Documentation updates and example creation

## Success Criteria

### Functional Requirements
- [ ] **Backward Compatibility**: All existing single-turn scenarios execute without modification
- [ ] **Multi-turn Execution**: Conversation scenarios execute successfully with realistic user simulation
- [ ] **User Simulation**: LLM generates persona-consistent, contextually appropriate responses
- [ ] **Termination Logic**: Conversation ends appropriately based on configured conditions
- [ ] **Evaluation System**: All new evaluation types provide meaningful insights
- [ ] **Matrix Testing**: Matrix scenarios support conversation parameters and execute correctly
- [ ] **Error Handling**: Graceful handling of LLM failures, timeouts, and edge cases

### Performance Requirements
- [ ] **Execution Time**: Conversation scenarios complete within reasonable time limits (max 5 minutes for 8-turn conversation)
- [ ] **Memory Usage**: Memory usage remains within acceptable bounds (max 2GB for complex scenarios)
- [ ] **LLM API Usage**: Optimized token usage and rate limiting (max 1000 tokens per user simulation)
- [ ] **Resource Efficiency**: No memory leaks or resource accumulation across multiple scenarios

### Quality Requirements
- [ ] **Test Coverage**: Comprehensive test coverage (unit: 90%, integration: 80%, e2e: 70%)
- [ ] **Error Handling**: Clear error messages and debugging capabilities
- [ ] **Documentation**: Well-documented examples and migration guide
- [ ] **Logging**: Comprehensive logging for debugging and monitoring
- [ ] **Metrics**: Performance metrics and conversation quality measurements

## Risk Mitigation

### Technical Risks

**Risk**: LLM API failures or rate limits
**Mitigation**: 
- Implement retry logic with exponential backoff
- Graceful degradation to simpler simulation strategies
- Configurable timeouts and fallback mechanisms
- Rate limiting and request queuing

**Risk**: Infinite conversation loops
**Mitigation**: 
- Hard `max_turns` limit (configurable, default 20)
- Termination conditions with LLM-based detection
- Timeout mechanisms per turn and total conversation
- Conversation stuck detection algorithms

**Risk**: Memory leaks from long conversations
**Mitigation**: 
- Turn-based cleanup and conversation archiving
- Memory limits and garbage collection
- Conversation result streaming for large transcripts
- Resource monitoring and alerts

### Integration Risks

**Risk**: Breaking existing scenarios
**Mitigation**: 
- Comprehensive backward compatibility testing
- Gradual rollout with feature flags
- Extensive test suite validation
- Clear migration path documentation

**Risk**: Performance impact on matrix testing
**Mitigation**: 
- Resource monitoring and optimization
- Parallel execution limits and queuing
- Performance benchmarking and optimization
- Scalable architecture design

## Dependencies

### Internal Dependencies
- Existing `askAgentViaApi` infrastructure in `packages/cli/src/commands/scenario/src/runtime-factory.ts`
- Current evaluation engine in `packages/cli/src/commands/scenario/src/EvaluationEngine.ts`
- Trajectory reconstruction in `packages/cli/src/commands/scenario/src/TrajectoryReconstructor.ts`
- LLM provider integration for user simulation
- Database schema (no changes required)

### External Dependencies
- LLM API access for user simulation
- Existing scenario infrastructure and providers
- Current CLI command structure

## Acceptance Criteria

### Phase 1 Acceptance (Weeks 1-2)
1. **Schema Validation**: All conversation schemas validate correctly
2. **Type Safety**: TypeScript compilation without errors
3. **User Simulator**: Generates realistic responses based on persona
4. **Backward Compatibility**: Existing scenarios pass unchanged

### Phase 2 Acceptance (Weeks 3-4)
1. **Conversation Execution**: Multi-turn conversations execute successfully
2. **Provider Integration**: Both local and cloud providers support conversations
3. **Termination Logic**: Conversations end appropriately based on conditions
4. **Error Handling**: Graceful handling of failures and timeouts

### Phase 3 Acceptance (Weeks 5-6)
1. **Evaluation Quality**: New evaluators provide meaningful insights
2. **Integration Testing**: End-to-end conversation scenarios work correctly
3. **Performance**: Meets performance requirements and resource limits
4. **Matrix Support**: Matrix testing works with conversation parameters

### Phase 4 Acceptance (Week 7)
1. **Documentation**: Clear examples and migration guide provided
2. **Examples**: Comprehensive example scenarios created
3. **Performance**: Optimized for production use
4. **Final Testing**: All acceptance criteria met and validated

## Related Documentation

- [Dynamic Prompting Guide](packages/cli/src/commands/scenario/DYNAMIC_PROMPTING_GUIDE.md) - Comprehensive implementation guide
- [Engineering Design](packages/cli/src/commands/scenario/DYNAMIC_PROMPTING_ENG_DESIGN.md) - Detailed technical design
- [Scenario Report Specification](packages/cli/src/commands/scenario/SCENARIO_REPORT_SPEC.md) - Report format specification
- [Scenario Examples](packages/cli/src/commands/scenario/examples/) - Example scenario files
- [CLI Documentation](packages/cli/README.md) - CLI command reference

## Implementation Notes

### Testing Strategy
- **Unit Tests**: Test individual components in isolation
- **Integration Tests**: Test component interactions and conversation flow
- **End-to-End Tests**: Test complete scenario execution
- **Backward Compatibility Tests**: Ensure existing scenarios work unchanged
- **Performance Tests**: Validate resource usage and execution time

### Debugging and Monitoring
- **Conversation Logging**: Detailed logs for conversation flow and decisions
- **Performance Metrics**: Execution time, memory usage, LLM API calls
- **Error Tracking**: Comprehensive error handling and reporting
- **Transcript Export**: Full conversation transcripts for analysis

### Future Enhancements
- **Advanced Personas**: More sophisticated user personality modeling
- **Multi-Agent Conversations**: Support for multiple agents in conversation
- **Emotional Intelligence**: Enhanced emotional state tracking and response
- **Conversation Analytics**: Advanced conversation quality metrics
- **Custom Evaluators**: Framework for custom conversation evaluators
