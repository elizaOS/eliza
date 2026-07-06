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
MODEL_NAME="anthropic/claude-sonnet-4-6" uv run python code_loop_explorer.py

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
  "model": "anthropic/claude-sonnet-4-6",
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — benchmark / eval suite:**
- A **real-model** run (not the mock/smoke fixture) producing the score-report JSON, with the numbers inspected and the provider/model recorded.
- The per-item trajectories the harness captured, spot-reviewed for correctness — a green harness run over mock fixtures is not a result.
- The provider matrix actually exercised, and the scoring math validated against a known case.
- Failure / timeout / partial-output handling in the harness itself.
<!-- END: evidence-and-e2e-mandate -->
