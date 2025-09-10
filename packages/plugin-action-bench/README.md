# plugin-action-bench

Action calling benchmark plugins for ElizaOS v2, featuring typewriter actions, multiverse mathematics with dimensional constants, and relational data management. Designed to test AI agents' ability to handle action chaining, context-dependent operations, and complex entity-relationship graphs.

> **🎛️ Environment Control**: Use `TYPEWRITER_ENABLED=false`, `MULTIVERSE_MATH_ENABLED=false`, or `RELATIONAL_DATA_ENABLED=false` to selectively disable benchmark sets. See [Environment Variable Configuration](#environment-variable-configuration) for details.

## Features

### 🔤 Typewriter Actions (A–Z)
26 single-letter typing actions that test basic action chaining and selection:
- **Actions**: `TYPE_A` through `TYPE_Z`
- **Purpose**: Tests rapid sequential action execution and accumulation
- **State Management**: Maintains `typedText` accumulator

### 🌌 Multiverse Math Operations
Mathematical operations that behave differently based on dimensional constants, testing AI agents' ability to handle context-dependent mathematics:

#### Number Input (0-9)
- **Actions**: `INPUT_0` through `INPUT_9`
- **Purpose**: Build numbers in the input buffer

#### Dimension Selection
- **SELECT_DIMENSION**: Choose which dimensional rules apply to operations
- **Available Dimensions**: quantum, chaos, prime, mirror, void, absolute, fibonacci, exponential, harmonic, infinite, golden, spiral, fractal, cyclical

#### Multiverse Operations

##### MULTIVERSE_ADD
Addition with dimensional variations:
- **Prime Dimension**: Results elevated to nearest prime number
- **Quantum Dimension**: Includes quantum entanglement factor √(a×b)
- **Chaos Dimension**: Adds deterministic chaos factor based on inputs

##### MULTIVERSE_SUBTRACT
Subtraction with dimensional rules:
- **Absolute Dimension**: Negative numbers don't exist (absolute value)
- **Mirror Dimension**: Reflects subtraction across zero
- **Void Dimension**: Creates void compensation (always positive)

##### MULTIVERSE_MULTIPLY
Multiplication across dimensions:
- **Fibonacci Dimension**: Results snap to nearest Fibonacci number
- **Exponential Dimension**: Multiplication becomes exponentiation
- **Harmonic Dimension**: Includes harmonic mean in calculation

##### MULTIVERSE_DIVIDE
Division with special meanings:
- **Safe Dimension**: Division by zero returns dividend
- **Infinite Dimension**: Division by zero opens portals (×999)
- **Golden Dimension**: Results converge toward golden ratio φ

##### MULTIVERSE_MODULO
Modulo with cyclical properties:
- **Cyclical Dimension**: Creates perfect positive cycles
- **Spiral Dimension**: Adds spiral patterns using sin/cos
- **Fractal Dimension**: Self-similar iterations

##### MULTIVERSE_POWER
Power operations with effects:
- **Standard Dimension**: Normal exponentiation
- **Imaginary Dimension**: Powers oscillate with cos factors
- **Recursive Dimension**: Power applied iteratively

##### MULTIVERSE_SQRT
Square root variations:
- **Positive Dimension**: Always returns positive (uses absolute)
- **Complex Dimension**: Handles negative numbers as imaginary
- **Quantum Dimension**: Adds quantum fluctuations

#### Utility Operations
- **MATH_STORE**: Store accumulator to memory
- **MATH_RECALL**: Recall memory to input buffer
- **MATH_CLEAR**: Reset all buffers
- **TRANSFER_TO_INPUT**: Move accumulator to input buffer

### 🔗 Relational Data Operations
Entity-relationship graph management for testing complex data operations:

#### Entity Management
- **CREATE_ENTITY**: Create entities with types (person, company, product, etc.)
- **SELECT_ENTITY**: Select an entity as the current focus
- **DELETE_ENTITY**: Delete entity and all its relationships
- **SET_ATTRIBUTE**: Add/update attributes on entities

#### Relationship Management
- **CREATE_RELATIONSHIP**: Link entities with typed relationships
  - Types: parent_child, sibling, friend, employment, ownership, management, partnership, membership, location, assignment

#### Query Operations
- **QUERY_ENTITIES**: Find entities by type or attribute values
- **QUERY_RELATIONSHIPS**: Find relationships by type or entity
- **FIND_PATH**: Find shortest path between two entities
- **COUNT_STATISTICS**: Get graph statistics (entity/relationship counts)

#### Utility Operations
- **CLEAR_GRAPH**: Reset the entire entity-relationship graph

## State Management

The plugin maintains a sophisticated state system:

### Typewriter State
- **typedText**: Accumulation buffer for typed characters

### Multiverse Math State
- **accumulator**: Main calculation result storage
- **inputBuffer**: Temporary number input storage
- **memory**: Persistent value storage
- **dimension**: Current dimensional constant affecting operations
- **history**: Operation history tracking with explanations

### Relational Data State
- **entities**: Collection of created entities with attributes
- **relationships**: Collection of relationships between entities
- **currentEntity**: Currently selected entity for operations
- **queryResults**: Results from recent queries

### Global State
- **lastOperation**: Track the most recent operation performed across all benchmarks

## Usage

```typescript
import { actionBenchPlugin } from "@elizaos/plugin-action-bench";

// Add to your agent's plugins
const agent = createAgent({
  plugins: [actionBenchPlugin],
  // ... other configuration
});
```

### Checking Configuration

You can verify which benchmarks are loaded programmatically:

```typescript
import { benchmarkConfig } from "@elizaos/plugin-action-bench";

console.log("Benchmark configuration:", benchmarkConfig);
// Output:
// {
//   typewriterEnabled: true,
//   multiverseMathEnabled: true,
//   relationalDataEnabled: true,
//   totalActionsLoaded: 58
// }
```

## Environment Variable Configuration

The plugin supports granular control over which benchmark actions are loaded through environment variables. This is useful for testing specific features or reducing the action space when not benchmarking.

### Available Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TYPEWRITER_ENABLED` | `true` | Controls loading of typewriter actions (A-Z) |
| `MULTIVERSE_MATH_ENABLED` | `true` | Controls loading of multiverse math operations |
| `RELATIONAL_DATA_ENABLED` | `true` | Controls loading of relational data operations |

### Examples

```bash
# Load all benchmarks (default)
npm start

# Only load typewriter actions
MULTIVERSE_MATH_ENABLED=false RELATIONAL_DATA_ENABLED=false npm start

# Only load multiverse math actions
TYPEWRITER_ENABLED=false RELATIONAL_DATA_ENABLED=false npm start

# Only load relational data actions
TYPEWRITER_ENABLED=false MULTIVERSE_MATH_ENABLED=false npm start

# Disable all benchmarks (useful for production)
TYPEWRITER_ENABLED=false MULTIVERSE_MATH_ENABLED=false RELATIONAL_DATA_ENABLED=false npm start
```

### .env File Configuration

You can also configure these in your `.env` file:

```env
# Enable/disable specific benchmarks
TYPEWRITER_ENABLED=true
MULTIVERSE_MATH_ENABLED=true
RELATIONAL_DATA_ENABLED=true

# Example: Only enable typewriter for focused testing
# TYPEWRITER_ENABLED=true
# MULTIVERSE_MATH_ENABLED=false
# RELATIONAL_DATA_ENABLED=false
```

### Runtime Feedback

The plugin provides console output to confirm which benchmarks are loaded:

```
[plugin-action-bench] Typewriter actions enabled
[plugin-action-bench] Multiverse math actions enabled
[plugin-action-bench] Relational data actions enabled
[plugin-action-bench] Total actions loaded: 58
```

Or when disabled:

```
[plugin-action-bench] Typewriter actions disabled via TYPEWRITER_ENABLED=false
[plugin-action-bench] Multiverse math actions enabled
[plugin-action-bench] Relational data actions enabled
[plugin-action-bench] Total actions loaded: 32
```

### Why Use Environment Variables?

The environment variable system provides several benefits:

1. **Reduce Action Space**: In production, disable benchmarks to reduce the number of actions the AI needs to consider
2. **Focused Testing**: Enable only specific benchmarks when testing particular capabilities
3. **Performance**: Fewer loaded actions means faster action selection and reduced memory usage
4. **Debugging**: Isolate specific action sets to debug issues
5. **A/B Testing**: Compare agent performance with different action sets enabled

Example scenarios:
- **Development**: Enable all benchmarks to test full capabilities
- **Production**: Disable all benchmarks to focus on real actions
- **Typewriter Testing**: Enable only typewriter to test rapid action chaining
- **Math Testing**: Enable only multiverse math to test context-dependent operations

## Benchmarking Examples

### Typewriter Test
Test rapid action selection by typing words:
```
User: "type hello"
Agent: Uses TYPE_H, TYPE_E, TYPE_L, TYPE_L, TYPE_O sequentially
```

### Dimensional Math Test
Test context-dependent mathematical operations:
```
User: "Set dimension to quantum, then add 5 and 3"
Agent: Uses SELECT_DIMENSION, INPUT_5, INPUT_3, MULTIVERSE_ADD
Result: In quantum dimension: 5 + 3 = 10.74 (includes √15 entanglement)
```

### Division by Zero Test
Test how different dimensions handle edge cases:
```
User: "Set dimension to infinite, divide 10 by 0"
Agent: Uses SELECT_DIMENSION, INPUT_1, INPUT_0, TRANSFER_TO_INPUT, INPUT_0, MULTIVERSE_DIVIDE
Result: In infinite dimension: 10 ÷ 0 = 9990 (portal opened!)
```

### Fibonacci Multiplication Test
Test dimensional constraints on operations:
```
User: "In fibonacci dimension, multiply 7 by 8"
Agent: Uses SELECT_DIMENSION, INPUT_7, TRANSFER_TO_INPUT, INPUT_8, MULTIVERSE_MULTIPLY
Result: In fibonacci dimension: 7 × 8 = 55 (nearest Fibonacci to 56)
```

### Complex Calculation Chain Test
Test multi-step calculations with dimension changes:
```
User: "Add 10 and 5 in prime dimension, then divide by 3 in golden dimension"
Agent: Uses dimension switching and chaining operations
Result: 10 + 5 = 17 (prime), then 17 ÷ 3 = 3.61 (converging to φ)
```

### Unknown Math Scenario Test
The multiverse approach tests if AI can understand contextual mathematics:
```
User: "Calculate the chaos-influenced sum of 15 and 23"
Agent: Must understand to set chaos dimension and apply MULTIVERSE_ADD
Result: Deterministic chaos factor added based on seed generation
```

### Relational Data Test
Test entity and relationship management:
```
User: "Create person named Alice, create company named TechCorp, create employment relationship"
Agent: Uses CREATE_ENTITY, CREATE_ENTITY, CREATE_RELATIONSHIP
Result: Graph with Alice → (employment) → TechCorp
```

### Complex Graph Query Test
Test graph traversal and querying:
```
User: "Create entities Bob and Carol, make them siblings, find path between them"
Agent: Creates entities, establishes sibling relationship, finds connection path
Result: Bob → (sibling) → Carol
```

### Attribute Management Test
Test entity attribute handling:
```
User: "Create person John, set age 30, set role manager, query person entities"
Agent: Uses CREATE_ENTITY, SET_ATTRIBUTE (×2), QUERY_ENTITIES
Result: John with {age: 30, role: "manager"}
```

## Development

This plugin is part of the ElizaOS ecosystem and follows the standard plugin architecture.
