# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is Solana Gym, a reinforcement learning environment for teaching AI agents to interact with the Solana blockchain. The project converts the Nvidia Minedojo Voyager experiment to work with a Solana environment called surfpool_env, which creates a local sandbox of Solana mainnet.

## Development Commands

### Running the Environment

```bash
# All Python commands should use uv run
uv run python voyager_env.py
uv run python simple_explorer.py
uv run python code_loop_explorer.py  # RECOMMENDED - best performance
uv run python -m pytest tests/
```

### Running Experiments

```bash
# Single run with Code Loop Explorer
USE_EXTERNAL_SURFPOOL=true uv run python code_loop_explorer.py

# With specific model
MODEL_NAME="anthropic/claude-3.5-sonnet" uv run python code_loop_explorer.py

# Batch comparison of multiple models
uv run python run_model_comparison_batch.py

# Environment variables
export USE_EXTERNAL_SURFPOOL=true  # Use existing surfpool instance
export MODEL_NAME="openai/gpt-4"   # Model to use
export MAX_MESSAGES=50              # Number of conversation turns
export RUN_INDEX=0                  # Run index for tracking
```

### TypeScript Skill Runner

```bash
# Navigate to skill runner directory
cd voyager/skill_runner

# Install dependencies
bun install

# Run tests
bun test

# Run a single test
bun test tests/single_transaction.test.ts

# Type check
bunx tsc --noEmit

# Lint
bunx eslint . --max-warnings 0
```

### Testing Individual Components

```bash
# Test the surfpool environment
uv run python -c "from surfpool_env import SurfpoolEnv; env = SurfpoolEnv(); env.reset()"

# Test skill execution
cd voyager/skill_runner && bun run runSkill.ts path/to/skill.ts 30000
```

## Architecture Overview

### Core Components

1. **SurfpoolEnv** (`surfpool_env.py`): Low-level environment managing the Solana test validator
   - Manages surfpool subprocess lifecycle
   - Handles raw transaction execution
   - Provides observation space (wallet balances, block height)
   - Calculates rewards based on protocol discovery
   - Tracks unique instructions per program (program_id, discriminator pairs)
   - Returns `unique_instructions` dict in step() info

2. **SolanaVoyagerEnv** (`voyager_env.py`): High-level Gymnasium wrapper
   - Skill-based action space (execute skill, generate new skill, inspect library)
   - LLM integration for skill generation
   - Transaction fetching from mainnet
   - Protocol discovery rewards

3. **CodeLoopExplorer** (`code_loop_explorer.py`): **RECOMMENDED** - Best performing agent
   - Simple conversation loop with LLM generating TypeScript code
   - No complex parsing - just regex extraction of code blocks
   - Immediate execution and feedback
   - Tracks detailed metrics including instructions per program
   - Default code file: `voyager/skill_runner/code_loop_code.ts`
   - Achieves highest rewards (60+ for Claude Sonnet 4)

4. **SimpleExplorer** (`simple_explorer.py`): Tool-based autonomous agent
   - Uses OpenAI function calling (tool use) for skill execution
   - Direct OpenRouter API integration
   - Cleaner message parsing than action.py

5. **TypeScriptSkillManager** (`voyager/skill_manager/ts_skill_manager.py`): Manages TypeScript skills
   - Skill registration and storage
   - Execution via Bun subprocess
   - No longer uses vectordb (removed for simplicity)

### Key Directories

- `/voyager/skill_runner/`: Bun runtime for executing TypeScript skills
- `/voyager/prompts/`: LLM prompt templates
- `/skills/`: Generated TypeScript skill storage
- `/ckpt/`: Checkpoints for different runs
- `/traces/`: Execution traces and rewards
- `/data/program_ids.csv`: Known Solana program mappings

## Debugging action.py & parse_ai_message

### Recent Fixes Applied

1. **babel_generator TypeError** (FIXED)
   - Issue: `babel_generator(node)` was failing with "this.m[ffid] is not a function"
   - Fix: Use `babel_generator.default` if it exists, otherwise use `babel_generator` directly
   - Location: `voyager/agents/action.py:126-127`

2. **Assertion syntax error** (FIXED)
   - Issue: Incorrect assertion syntax using comma instead of `and`
   - Fix: Changed to proper boolean expression with `and`
   - Location: `voyager/agents/action.py:149-152`

3. **Deprecated langchain imports** (FIXED)
   - Updated from `langchain.chat_models.openai` to `langchain_openai`

### Current Implementation

1. **action.py** uses regex and Babel parsing to extract JavaScript/TypeScript code from AI messages
   - Located at: `voyager/agents/action.py:99-161`
   - Fragile parsing with hardcoded patterns
   - Expects specific function signatures

2. **parse_ai_message** implementations:
   - `action.py:99`: Uses Babel to parse JS/TS code blocks
   - `curriculum.py:145`: Simple line-by-line parsing for tasks

### Recommended Approach

The **SimpleExplorer** implementation is more robust:
- Uses OpenAI's structured function calling API
- No regex or code parsing needed
- Clear separation of actions via tool definitions
- See `simple_explorer.py:127-197` for implementation

### Key Differences

**action.py approach** (problematic):
```python
# Extracts code blocks with regex
code_pattern = re.compile(r"```(?:javascript|js|typescript|ts)(.*?)```", re.DOTALL)
# Parses with Babel
parsed = babel.parse(code)
```

**SimpleExplorer approach** (recommended):
```python
# Uses structured tool calls
for tool_meta in response.choices[0].message.tool_calls:
    function_name = tool_meta.function.name
    function_args = json.loads(tool_meta.function.arguments)
```

## Metrics and Tracking

### Metrics Structure

The Code Loop Explorer tracks detailed metrics in JSON files saved to `/metrics/`:

```json
{
  "model": "anthropic/claude-3.5-sonnet",
  "run_index": 0,
  "messages": [
    {
      "index": 1,
      "timestamp": "2025-08-11T10:00:00",
      "duration": 5.2,
      "reward": 3,
      "total_reward": 3,
      "instructions_discovered": 3
    }
  ],
  "cumulative_rewards": [0, 3, 5, 8, ...],
  "programs_discovered": {
    "11111111111111111111111111111111": 1,  // Message index when first discovered
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr": 1
  },
  "instructions_by_program": {
    "11111111111111111111111111111111": [0, 1, 2],  // Discriminators discovered
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": [0, 1, 3, 7]
  }
}
```

### Recent Improvements (August 2025)

1. **Per-Program Instruction Tracking**: Added detailed tracking of unique instructions per program
2. **Improved Logging**: Transaction success now logs instructions discovered per step
3. **Removed Vectordb**: Simplified TypeScriptSkillManager by removing unused vectordb code
4. **Batch Experiment Runner**: Added `run_model_comparison_batch.py` for parallel model testing
5. **Code File Management**: Code Loop Explorer now defaults to `voyager/skill_runner/code_loop_code.ts`

## Important Notes

1. Always use `uv run` for Python commands
2. **Code Loop Explorer is the recommended approach** - achieves best results with simple design
3. Skills are limited to ONE transaction per execution (enforced in runSkill.ts)
4. The environment uses a local Solana validator (surfpool) for safe testing
5. Real mainnet transactions can be fetched for learning examples
6. Rewards are based on unique (program_id, instruction_discriminator) pairs discovered
7. The Memo program can inflate scores - consider filtering it for fair comparisons
- remember that we built trajectory visualizers with react for use in github pages
- remember that we built a script to create ordered bench tables
- remember we changed the docs to react