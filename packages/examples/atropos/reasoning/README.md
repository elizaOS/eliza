# ElizaOS Atropos - Reasoning Gym Environment

A reasoning and problem-solving environment for training ElizaOS agents using the Atropos RL framework.

## Overview

Reasoning Gym provides structured reasoning tasks to develop and evaluate AI reasoning capabilities:
- **Mathematical reasoning**: Arithmetic, algebra, word problems
- **Logical reasoning**: Deduction, syllogisms, puzzles
- **Multi-step reasoning**: Chain-of-thought problems
- **Commonsense reasoning**: Real-world knowledge application

## Installation

```bash
# From the repository root
pip install -e examples/atropos/reasoning
```

## Quick Start

```bash
# Run evaluation on math problems
python -m elizaos_atropos_reasoning --mode eval --task math

# Interactive problem solving
python -m elizaos_atropos_reasoning --mode interactive

# Run full benchmark
python -m elizaos_atropos_reasoning --mode benchmark
```

## Task Categories

### 1. Mathematical Reasoning

#### Arithmetic
- Basic operations (add, subtract, multiply, divide)
- Order of operations
- Percentages and ratios

#### Algebra
- Solving equations
- Word problems with variables
- Systems of equations

#### Word Problems
- Multi-step word problems
- Rate and distance problems
- Probability scenarios

### 2. Logical Reasoning

#### Deduction
- If-then statements
- Truth tables
- Logical proofs

#### Syllogisms
- Classical syllogisms
- Categorical reasoning
- Validity checking

#### Puzzles
- Knights and Knaves
- River crossing
- Constraint satisfaction

### 3. Multi-step Reasoning

#### Chain of Thought
- Step-by-step problem decomposition
- Intermediate result tracking
- Error correction

#### Planning
- Task sequencing
- Resource allocation
- Goal achievement

### 4. Commonsense Reasoning

#### Physical Reasoning
- Cause and effect
- Object properties
- Spatial relations

#### Social Reasoning
- Intentions and beliefs
- Social norms
- Theory of mind

## Environment Interface

```python
from elizaos import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_atropos_reasoning import (
    ReasoningEnvironment,
    ReasoningAgent,
    TaskType,
)

# Create environment
env = ReasoningEnvironment(task_type=TaskType.MATH)
await env.initialize()

# Create agent
runtime = AgentRuntime(plugins=[get_openai_plugin()])
await runtime.initialize()
agent = ReasoningAgent(runtime)

# Solve problems
state = await env.reset()

while not state.done:
    # Agent generates reasoning steps
    response = await agent.reason(state)
    
    # Environment evaluates response
    state = await env.step(response)
    
    if state.feedback:
        print(f"Feedback: {state.feedback}")

print(f"Score: {state.score}")
```

## Atropos Integration

```python
from atropos import AtroposClient
from elizaos_atropos_reasoning import ReasoningEnvironment

# Register with Atropos
client = AtroposClient()
client.register_environment(ReasoningEnvironment)

# Collect reasoning trajectories
trajectories = await client.collect_rollouts(
    num_problems=1000,
    task_type="math",
    difficulty="medium",
)
```

## Evaluation Metrics

| Metric | Description |
|--------|-------------|
| Accuracy | Percentage of correct final answers |
| Step Accuracy | Percentage of correct intermediate steps |
| Reasoning Quality | Quality of explanation/reasoning |
| Efficiency | Steps taken vs. optimal solution |

## Difficulty Levels

### Easy
- Single-step problems
- Basic operations
- Explicit information

### Medium
- Multi-step problems
- Moderate complexity
- Some inference required

### Hard
- Complex multi-step reasoning
- Multiple constraints
- Implicit information

## Example Problems

### Math (Easy)
```
Problem: What is 15% of 80?
Expected: 12
```

### Math (Medium)
```
Problem: A store sells shirts for $25 each. If you buy 3 or more, 
you get a 20% discount. How much would 4 shirts cost?
Expected: $80
```

### Logic (Medium)
```
Problem: If it's raining, the ground is wet. The ground is wet.
Is it definitely raining?
Expected: No (affirming the consequent fallacy)
```

### Reasoning (Hard)
```
Problem: Alice, Bob, and Carol each have a different pet: a cat, 
a dog, or a bird. Alice doesn't have the cat. Bob's pet can't fly.
Carol's pet is not the dog. Who has which pet?
Expected: Alice-dog, Bob-cat, Carol-bird
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `task_type` | `MATH` | Type of reasoning tasks |
| `difficulty` | `MEDIUM` | Problem difficulty |
| `max_steps` | `5` | Maximum reasoning steps |
| `seed` | `None` | Random seed |

## Architecture

```
elizaos_atropos_reasoning/
├── __init__.py           # Package exports
├── types.py              # Task types, problem definitions
├── problems/
│   ├── __init__.py       # Problem generators
│   ├── math.py           # Math problem generators
│   ├── logic.py          # Logic problem generators
│   └── puzzles.py        # Puzzle generators
├── evaluator.py          # Answer evaluation
├── environment.py        # ReasoningEnvironment class
├── agent.py              # ElizaOS agent integration
└── cli.py                # Command-line interface
```

## License

MIT License - Part of the ElizaOS project.
