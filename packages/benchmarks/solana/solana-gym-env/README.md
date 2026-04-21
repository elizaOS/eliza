# Solana Bench

> **How Well Can LLMs Build Complex Transactions?** - Two lightweight, open-ended environments designed to test LLMs' operational competence on Solana in a way that is simple, reproducible, and objective. [See the blog post here](https://solana-foundation.github.io/solana-gym-env)

## Introduction

At the Solana Foundation, we want to fund open-source AI tooling that measurably improves how developers and applications use Solana. Until now, we haven't had a simple, reproducible way to evaluate whether new tools actually make it easier for language models to build and run transactions on Solana. **Solana Bench** provides two environments:

1. **Basic** - maximize the number of new instructions successfully executed using only foundational SDKs (e.g. @solana/web3.js, Anchor, etc)
2. **Swap** - same success criterion, but within a DeFi-leaning surface (Jupiter, Orca, Raydium, Phoenix, Meteora) using additional example prompts and preinstalled SDKs

These environments reward composing valid transactions, choosing accounts appropriately, using SDKs correctly, recovering from errors, and exploring breadth across programs.

## Grant Opportunities

**We're funding proposals for open-sourced research on high-quality Solana benchmarks!**

Ideas we're excited about:

- **Protocol Environments**: Create environments for specific protocols to understand which DeFi protocols LLMs handle best
- **DevEx Environments**: Test LLMs with only IDLs or IDL-generated methods instead of SDKs
- **System Prompt Improvements**: Well-explained improvements that yield meaningful benchmark changes
- **Custom Model Evaluations**: Evaluate your custom Solana models with reproducible methodology

📧 **Contact us at [ai@solana.org](mailto:ai@solana.org)**

📝 **[Apply for funding here](https://share.hsforms.com/1GE1hYdApQGaDiCgaiWMXHA5lohw)**

📊 **[See detailed trajectories and code generation examples](https://solana-foundation.github.io/solana-gym-env/trajectories)**

## Key Results

### Basic Benchmark

| Model               | Median Score | Max Score | Min Score | Median Programs |
| ------------------- | ------------ | --------- | --------- | --------------- |
| **claude-sonnet-4** | **115**      | 181       | 30        | 5               |
| gpt-5               | 60           | 66        | 57        | 8               |
| gemini-2.5-flash    | 40           | 44        | 23        | 6               |
| gpt-oss-120b        | 23           | 25        | 16        | 6               |

### Swap Benchmark (Filtered)

| Model            | Median Score | Max Score | Min Score | Median Programs |
| ---------------- | ------------ | --------- | --------- | --------------- |
| **gpt-5**        | **30**       | 34        | 27        | 16              |
| claude-sonnet-4  | 33\*         | 102\*     | 19        | 6               |
| gemini-2.5-flash | 14           | 18        | 0         | 3               |
| gpt-oss-120b     | 10           | 22        | 8         | 4               |

\*Claude achieved higher raw scores by gaming the metric with Memo instructions. After filtering, GPT-5 outperforms.

## Takeaways for Solana Developers

**For App Builders**: Put SDK examples on documentation sites and crawler-accessible places. LLM-readiness should be part of every team's developer adoption strategy.

**For Developers**: Host APIs that abstract away compositional logic - wrapping/unwrapping SOL, creating ATAs, setting compute limits, and protocol-specific initialization. LLMs understand Jupiter's API well because it abstracts complexity.

## Quick Start

```bash
# Run a single exploration session
export MODEL_NAME="google/gemini-2.5-flash"  # or "openai/gpt-4o-mini", "openai/gpt-oss-120b", etc.
export MAX_MESSAGES=50
uv run python code_loop_explorer.py

# Run model comparison batch (recommended)
uv run python run_model_comparison_batch.py

# Analyze results with advanced visualizations
uv run python analyze_code_loop_performance.py
```

## Scoring

1. **Budget**: 50 messages per model per run
2. **Per-turn constraint**: Model emits TypeScript that must produce exactly one unsigned transaction
3. **Execution**: Run against sandboxed Solana validator ([Surfpool](https://surfpool.run)) that mimics mainnet
4. **Score**: Number of unique instructions from successfully executed transactions. Instructions identified by first byte of instruction data.

### Prerequisites

- Python 3.8+ with [uv](https://github.com/astral-sh/uv)
- [Bun](https://bun.sh) v1.1.42+
- [Surfpool](https://github.com/novy4/surfpool) (Solana test environment)
- OpenRouter API key for LLM access

### Setup

```bash
# Clone the repository
git clone https://github.com/solana-foundation/solana-gym-env
cd voyager

# Install Python dependencies
uv sync

# Install TypeScript dependencies
cd voyager/skill_runner && bun install
cd ../..

# Set up environment variables
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY
```

## Running Experiments

```bash
# Single run with specific model
export MODEL_NAME="google/gemini-2.5-flash"
export MAX_MESSAGES=50
export ENVIRONMENT_CONFIG="basic"
uv run python code_loop_explorer.py

# Batch comparison of multiple models
# To switch environments between "basic" and "swap"
# you must edit this file
uv run python run_model_comparison_batch.py
```

## Model Comparison & Analysis

### Running Comparisons

```bash
# Analyze results with comprehensive visualizations
uv run python analyze_code_loop_performance.py
```

## Troubleshooting

### Surfpool Issues

```bash
# Check if surfpool is installed
which surfpool

# Test surfpool with custom port
surfpool start -u https://api.mainnet-beta.solana.com -p 8901 --no-tui
```

### Bun/TypeScript Issues

```bash
# Ensure you're in the skill_runner directory
cd voyager/skill_runner
bun install
bun test
```

## Contributing

Contributions are welcome! Areas of interest:

- New exploration strategies
- Additional model integrations
- Enhanced reward mechanisms
- Protocol-specific exploration

## Running the Full Benchmark

It costs about $150-200 USD to run all the models in this benchmark.
The costs primarily come from `anthropic/claude-sonnet-4`. It is nearly 10x
more expensive than `google/gemini-2.5-flash`.

Running the main script will run all the models at once against a `surfpool` instance.
**You must have `surfpool start` running in a different terminal.**

```bash
$ USE_EXTERNAL_SURFPOOL=true uv run run_model_comparison_batch.py
============================================================
CODE LOOP MODEL COMPARISON BATCH (PARALLEL)
============================================================
Models to test: 4
  - google/gemini-2.5-flash
  - openai/gpt-oss-120b
  - anthropic/claude-sonnet-4
  - qwen/qwen3-coder
Runs per model: 5
Messages per run: 50
Total experiments: 20
Parallel batch size: 20

⏱️  Time Estimates:
  Sequential: ~240 minutes
  Parallel: ~12 minutes
  Speedup: ~20.0x

✅ Using EXTERNAL surfpool instance on localhost:8899
============================================================

Proceed with parallel execution? (y/n): y

🚀 Starting 20 experiments in batches of 20

📦 Batch 1/1 (20 experiments)
──────────────────────────────────────────────────
  🚀 Starting google/gemini-2.5-flash run 0 (file: batch_google_gemini_2.5_flash_0_164011.ts)
  🚀 Starting google/gemini-2.5-flash run 1 (file: batch_google_gemini_2.5_flash_1_164011.ts)
  🚀 Starting google/gemini-2.5-flash run 2 (file: batch_google_gemini_2.5_flash_2_164011.ts)
  🚀 Starting google/gemini-2.5-flash run 3 (file: batch_google_gemini_2.5_flash_3_164011.ts)
  🚀 Starting google/gemini-2.5-flash run 4 (file: batch_google_gemini_2.5_flash_4_164011.ts)
  🚀 Starting openai/gpt-oss-120b run 0 (file: batch_openai_gpt_oss_120b_0_164011.ts)
  🚀 Starting openai/gpt-oss-120b run 1 (file: batch_openai_gpt_oss_120b_1_164011.ts)
  🚀 Starting openai/gpt-oss-120b run 2 (file: batch_openai_gpt_oss_120b_2_164011.ts)
  🚀 Starting openai/gpt-oss-120b run 3 (file: batch_openai_gpt_oss_120b_3_164011.ts)
  🚀 Starting openai/gpt-oss-120b run 4 (file: batch_openai_gpt_oss_120b_4_164011.ts)
  🚀 Starting anthropic/claude-sonnet-4 run 0 (file: batch_anthropic_claude_sonnet_4_0_164011.ts)
  🚀 Starting anthropic/claude-sonnet-4 run 1 (file: batch_anthropic_claude_sonnet_4_1_164011.ts)
  🚀 Starting anthropic/claude-sonnet-4 run 2 (file: batch_anthropic_claude_sonnet_4_2_164011.ts)
  🚀 Starting anthropic/claude-sonnet-4 run 3 (file: batch_anthropic_claude_sonnet_4_3_164011.ts)
  🚀 Starting anthropic/claude-sonnet-4 run 4 (file: batch_anthropic_claude_sonnet_4_4_164011.ts)
  🚀 Starting qwen/qwen3-coder run 0 (file: batch_qwen_qwen3_coder_0_164011.ts)
  🚀 Starting qwen/qwen3-coder run 1 (file: batch_qwen_qwen3_coder_1_164011.ts)
  🚀 Starting qwen/qwen3-coder run 2 (file: batch_qwen_qwen3_coder_2_164011.ts)
  🚀 Starting qwen/qwen3-coder run 3 (file: batch_qwen_qwen3_coder_3_164011.ts)
  🚀 Starting qwen/qwen3-coder run 4 (file: batch_qwen_qwen3_coder_4_164011.ts)
  ✅ google/gemini-2.5-flash run 4 completed
  ✅ google/gemini-2.5-flash run 2 completed
  ✅ qwen/qwen3-coder run 3 completed
  ✅ qwen/qwen3-coder run 2 completed
  ✅ qwen/qwen3-coder run 4 completed
  ✅ google/gemini-2.5-flash run 3 completed
  ✅ google/gemini-2.5-flash run 0 completed
  ✅ google/gemini-2.5-flash run 1 completed
  ✅ qwen/qwen3-coder run 0 completed
  ✅ qwen/qwen3-coder run 1 completed
  ✅ anthropic/claude-sonnet-4 run 2 completed
  ✅ openai/gpt-oss-120b run 1 completed
  ✅ openai/gpt-oss-120b run 3 completed
  ✅ openai/gpt-oss-120b run 2 completed
  ✅ openai/gpt-oss-120b run 4 completed
  ✅ openai/gpt-oss-120b run 0 completed
  ✅ anthropic/claude-sonnet-4 run 3 completed
  ✅ anthropic/claude-sonnet-4 run 0 completed
  ✅ anthropic/claude-sonnet-4 run 1 completed
  ✅ anthropic/claude-sonnet-4 run 4 completed
  ⏱️  Batch completed in 1072.0 seconds
============================================================
Total experiments: 20
Successful: 20/20
Failed: 0

⏱️  Performance:
  Total time: 1072.0 seconds (17.9 minutes)
  Average per experiment: 53.6 seconds
  Effective speedup: ~13.4x

📊 Results by Model:
  google/gemini-2.5-flash: 5/5 successful
  openai/gpt-oss-120b: 5/5 successful
  anthropic/claude-sonnet-4: 5/5 successful
  qwen/qwen3-coder: 5/5 successful

📈 To analyze results, run:
  uv run python analyze_code_loop_performance.py
============================================================
```

You can then generate all the graphs with

```bash
$ uv run analyze_code_loop_performance.py
============================================================
CODE LOOP EXPLORER ANALYSIS
============================================================

📁 Created output directory: analysis_results/code_loop_20250808_170341

📂 Loading code_loop metrics...
✅ Found 20 code_loop runs to analyze

============================================================
PROGRAMS DISCOVERED BY MODEL
============================================================

📊 anthropic/claude-sonnet-4:
   Total unique programs: 6
   - Token 2022                     (TokenzQd...): 35 interactions
   - Token Program                  (Tokenkeg...): 32 interactions
   - Associated Token Account       (ATokenGP...): 32 interactions
   - Memo Program                   (MemoSq4g...): 11 interactions
   - System Program                 (11111111...): 5 interactions
   - Compute Budget                 (ComputeB...): 5 interactions

📊 google/gemini-2.5-flash:
   Total unique programs: 7
   - Compute Budget                 (ComputeB...): 58 interactions
   - Unknown Program                (Vote1111...): 46 interactions
   - Token Program                  (Tokenkeg...): 38 interactions
   - Token 2022                     (TokenzQd...): 36 interactions
   - Associated Token Account       (ATokenGP...): 25 interactions
   - Memo Program                   (MemoSq4g...): 23 interactions
   - System Program                 (11111111...): 19 interactions

📊 openai/gpt-oss-120b:
   Total unique programs: 7
   - Associated Token Account       (ATokenGP...): 55 interactions
   - Stake Program                  (Stake111...): 49 interactions
   - Token 2022                     (TokenzQd...): 43 interactions
   - Token Program                  (Tokenkeg...): 28 interactions
   - System Program                 (11111111...): 15 interactions
   - Memo Program                   (MemoSq4g...): 15 interactions
   - Compute Budget                 (ComputeB...): 15 interactions

📊 qwen/qwen3-coder:
   Total unique programs: 5
   - Memo Program                   (MemoSq4g...): 87 interactions
   - Compute Budget                 (ComputeB...): 9 interactions
   - System Program                 (11111111...): 9 interactions
   - Associated Token Account       (ATokenGP...): 4 interactions
   - Token Program                  (Tokenkeg...): 4 interactions
📊 Program discovery plots saved to: analysis_results/code_loop_20250808_170341/program_discovery.png

============================================================
CODE LOOP PERFORMANCE SUMMARY
============================================================

By Model:
                          total_reward             success_rate      programs_discovered     unique_instructions
                                  mean    std  max         mean  std                mean max                mean max
model
anthropic/claude-sonnet-4         72.2  51.26  139          0.0  0.0                 5.0   6                 0.0   0
google/gemini-2.5-flash           29.4  16.99   42          0.0  0.0                 5.0   7                 0.0   0
openai/gpt-oss-120b               18.4   6.07   26          0.0  0.0                 5.8   7                 0.0   0
qwen/qwen3-coder                  13.6   3.05   17          0.0  0.0                 3.4   5                 0.0   0

🏆 Top 5 Runs by Total Reward:
                    model                             run_id  total_reward  programs_discovered
anthropic/claude-sonnet-4 code_loop_25-08-08_164012_9138bbf9           139                    5
anthropic/claude-sonnet-4 code_loop_25-08-08_164012_93f08ce9           110                    4
anthropic/claude-sonnet-4 code_loop_25-08-08_164012_2b5128e5            56                    6
anthropic/claude-sonnet-4 code_loop_25-08-08_164012_264a312e            43                    6
  google/gemini-2.5-flash code_loop_25-08-08_164012_f60de86f            42                    6

✅ Top 5 Runs by Success Rate:
                    model                             run_id  success_rate  total_reward
anthropic/claude-sonnet-4 code_loop_25-08-08_164012_9138bbf9             0           139
anthropic/claude-sonnet-4 code_loop_25-08-08_164012_93f08ce9             0           110
anthropic/claude-sonnet-4 code_loop_25-08-08_164012_2b5128e5             0            56
anthropic/claude-sonnet-4 code_loop_25-08-08_164012_264a312e             0            43
  google/gemini-2.5-flash code_loop_25-08-08_164012_f60de86f             0            42

💾 Summary statistics saved to: analysis_results/code_loop_20250808_170341/summary_statistics.csv

📊 Creating visualizations...
📊 Performance plots saved to: analysis_results/code_loop_20250808_170341/performance_overview.png
📊 Error bar plots saved to: analysis_results/code_loop_20250808_170341/error_bars.png
📊 Reward progression plot saved to: analysis_results/code_loop_20250808_170341/reward_progression.png
📊 Individual trajectories plot saved to: analysis_results/code_loop_20250808_170341/individual_trajectories.png

✅ Analysis complete! All results saved to: analysis_results/code_loop_20250808_170341
📁 analysis_results/code_loop_20250808_170341/
   ├── summary_statistics.csv
   ├── program_discovery.png
   ├── performance_overview.png
   ├── error_bars.png
   ├── reward_progression.png
   └── individual_trajectories.png
```

## Acknowledgments

- NVIDIA MineDojo team for the original Voyager paper
- The Surfpool team for the testing environment (surfpool.run)
- All contributors to the Solana AI ecosystem
