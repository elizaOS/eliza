# Rolodex Plugin Multi-Agent Scenarios

This directory contains comprehensive multi-agent scenarios designed to test the Rolodex plugin's entity tracking, relationship building, trust management, and follow-up scheduling capabilities.

## Overview

These scenarios use the ElizaOS CLI scenario runner to spin up multiple agents (up to 10) that interact in realistic ways to test the plugin's core functionality. Each scenario creates ground truth data to verify that entity and relationship development is working correctly.

## Scenarios

### 1. Entity Introduction and Extraction (`entity-introduction.ts`)
- **Agents**: 5 (4 professionals + 1 tracker)
- **Duration**: 20 seconds
- **Tests**: 
  - Basic entity extraction from introductions
  - Professional information capture (roles, companies, social media)
  - Entity search functionality
  - Metadata extraction

### 2. Relationship Building and Evolution (`relationship-building.ts`)
- **Agents**: 6 (5 team members + 1 tracker)
- **Duration**: 25 seconds
- **Tests**:
  - Relationship formation through collaboration
  - Different relationship types (leadership, mentorship, peer)
  - Relationship strength based on interaction frequency
  - Complex relationship queries

### 3. Trust Evolution and Security (`trust-evolution.ts`)
- **Agents**: 7 (4 trusted + 2 adversaries + 1 monitor)
- **Duration**: 20 seconds
- **Tests**:
  - Trust score increases for positive behavior
  - Trust score decreases for suspicious behavior
  - Security threat detection
  - Phishing and credential request detection

### 4. Complex Professional Network (`complex-network.ts`)
- **Agents**: 10 professionals + 1 analyzer
- **Duration**: 20 seconds
- **Tests**:
  - Large-scale entity tracking
  - Complex relationship network mapping
  - Entity resolution with mentions (@mentions)
  - Network analysis and connectivity queries

### 5. Follow-up Scheduling and Management (`follow-up-management.ts`)
- **Agents**: 8 (7 team members + 1 tracker)
- **Duration**: 20 seconds
- **Tests**:
  - Follow-up scheduling with priorities
  - Time-based reminders
  - Entity-associated commitments
  - Follow-up search and filtering

## Running the Scenarios

From the CLI directory:

```bash
# Run all rolodex scenarios
elizaos scenario --filter "rolodex-*"

# Run a specific scenario
elizaos scenario --scenarios "rolodex-entity-introduction"

# Run with verbose output
elizaos scenario --filter "rolodex-*" --verbose

# Run with benchmark mode
elizaos scenario --filter "rolodex-*" --benchmark
```

## Verification Rules

Each scenario includes LLM-based verification rules that check:

1. **Entity Tracking**: All introduced entities are properly tracked
2. **Information Extraction**: Roles, companies, and metadata are captured
3. **Relationship Mapping**: Connections between entities are identified
4. **Trust Scoring**: Trust evolves based on behavior patterns
5. **Query Accuracy**: Search queries return correct results

## Expected Outcomes

### Entity Introduction
- All 4 professionals tracked with metadata
- Companies and roles extracted
- Social media handles captured
- Search queries work correctly

### Relationship Building
- 8+ relationships identified
- Different relationship types recognized
- Strength varies by interaction frequency
- Mentor-mentee relationship for Bob-Eve

### Trust Evolution
- Alice, Bob, Carol have high trust (>0.7)
- Eve, Grace have low trust (<0.3)
- Frank has neutral trust (~0.5)
- Suspicious behaviors flagged

### Complex Network
- 10 entities tracked
- 15+ relationships mapped
- Entity resolution handles @mentions
- Network hubs identified (Alice, Bob, Carol)

### Follow-up Management
- 5+ follow-ups scheduled
- Different priority levels assigned
- Time-based scheduling captured
- Entity associations correct

## Architecture

Each scenario follows this structure:

```typescript
{
  actors: [
    // Multiple agents with roles and scripts
  ],
  setup: {
    // Room configuration and context
  },
  execution: {
    // Timing and step limits
  },
  verification: {
    // LLM-based verification rules
  },
  benchmarks: {
    // Performance metrics
  }
}
```

## Key Features Tested

1. **Entity Extraction**: Names, roles, companies, social media
2. **Relationship Inference**: Based on mentions, collaboration, interactions
3. **Trust Management**: Behavioral analysis, security detection
4. **Entity Resolution**: Handling mentions, similar names, references
5. **Search Capabilities**: Natural language queries, filtering
6. **Follow-up System**: Scheduling, priorities, reminders
7. **Scale Testing**: Up to 10 agents interacting simultaneously

## Customization

To create new scenarios:

1. Copy an existing scenario as a template
2. Define your agents with appropriate roles and scripts
3. Set up verification rules for your test objectives
4. Add to the index.ts exports
5. Run with the scenario runner

## Debugging

If scenarios fail:

1. Check the transcript for unexpected behavior
2. Review verification rule results
3. Ensure all agents have the rolodex plugin loaded
4. Verify action names match the plugin's exports
5. Check timing - agents may need more wait time

## Future Enhancements

- Scenarios for entity merging/deduplication
- Cross-room entity tracking
- Long-term relationship evolution
- Group dynamics and team formation
- Conflict resolution and trust recovery 