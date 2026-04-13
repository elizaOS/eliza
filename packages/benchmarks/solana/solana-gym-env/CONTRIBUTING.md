# Contributing to Solana Bench

### Getting Started

1. **Fork the repo**: [github.com/solana-foundation/solana-gym-env](https://github.com/solana-foundation/solana-gym-env)
2. **Pick a protocol**: Choose one you know well
3. **Create your environment**: Use our template as a starting point
4. **Test with multiple models**: Ensure it works across different LLMs
5. **Submit a PR**: Include example runs and performance metrics

### What Makes a Great Contribution

**Clear, Protocol-Specific Prompts**: Models should understand what they're exploring

**Comprehensive SDK Examples**: Real code that works on mainnet

**Meaningful Reward Shaping**: Incentivize learning the protocol deeply

**Documentation**: Explain why your approach teaches models effectively

**Evaluation Metrics**: Show how different models perform

## Example: Kamino-Specific Environment

Here's what a Kamino contribution might look like:

```python
class KaminoLendingExplorer(CodeLoopExplorer):
    def get_system_prompt(self):
        return f"""
        You are exploring Kamino Lending Protocol.

        Core Concepts:
        - Obligations: User's borrow/lend positions
        - Reserves: Lending pools for different assets
        - kTokens: Receipt tokens for deposits

        Available SDK: @kamino-finance/klend-sdk

        Examples:
        {self.load_kamino_examples()}
        """

    def calculate_reward(self, tx_info):
        base_reward = super().calculate_reward(tx_info)

        # Kamino-specific bonus rewards
        if self.completed_deposit_borrow_repay_cycle():
            base_reward += 10  # Full lending cycle bonus

        if self.used_leverage_properly():
            base_reward += 5   # Advanced feature bonus

        if self.interacted_with_new_reserve():
            base_reward += 3   # Exploration bonus

        return base_reward
```

## Contribute Different Language Environments!

- **Rust**: solana-program
- **Python**: solana-py, anchorpy ecosystems
- **Go**: gagliardetto/solana-go patterns

### Each Environment Needs the Following

1. **Custom System Prompts** with your protocol's concepts
2. **SDK Integration Examples** showing real usage patterns
3. **Reward Functions** that measure protocol mastery
4. **Success Criteria** specific to your protocol

## Open Research Challenges

### The Multiplication Problem

If we need 10 protocols × 3 SDKs × 3 languages = 90 unique environments, we're probably doing something wrong.

**What might work better:**

- **"Raw" Environments**: Force models to build everything from scratch with ONLY @solana/web3.js
- **Auto-discovery from IDLs**: Automatically generate rewards from program IDLs
- **Transaction Mining**: Learn protocol patterns from historical transactions
- **Cross-protocol transfer**: Can knowledge of one DEX help with another?

### Protocol-Agnostic Discovery

The holy grail would be an environment where models can discover and interact with ANY protocol without protocol-specific prompts.

**Dream contribution**: A system that can:

1. Take any program ID
2. Fetch its IDL (if available) or reverse-engineer from transactions
3. Generate exploration strategies
4. Create meaningful rewards without human intervention

### Concrete Research Ideas

**"Raw" Environment Challenge #1: Pure Discovery**

Start with a raw environment using ONLY @solana/web3.js - no protocol SDKs allowed. Can a model figure out how to swap on Jupiter just from the program ID and fetched transactions? This tests true protocol understanding.

**"Raw" Environment Challenge #2: Auto-Generated SDKs with @solana/kit**

What if we could make ANY protocol work automatically? Here's the idea:

1. **Pick any Solana program** (like Jupiter or Drift)
2. **Fetch its IDL** from the chain
3. **Use Codama to auto-generate a TypeScript SDK** from that IDL
4. **Include the SDK in the model's prompt** ("Here's how to interact with this program...")
5. **Prepend the SDK to whatever code the model writes** (so it actually compiles)
6. **Run it with @solana/kit** (Codama SDKs only work with kit, not web3.js)

This would be a separate "raw" environment - just Codama + @solana/kit. No manual protocol-specific work needed! Point at a program ID and go. The model sees nice TypeScript functions instead of raw instruction building.

Even better: After collecting successful runs, export them to OpenPipe or similar for fine-tuning. Build first, train later.

## Debugging Your Experiments

### 🔍 LangGraph Studio - See Everything

LangGraph Studio is invaluable for debugging your agent's behavior. It shows you the complete input/output for every LLM call, making it easy to spot where things go wrong.

**Setup**:

```bash
# Add to your .env file
LANGGRAPH_API_KEY=your_api_key_here

# LangGraph will automatically log all LangChain interactions
```

**What You'll See**:

- Full message history with token counts
- Exact tool calls and responses
- Model reasoning in real-time
- Where models get stuck or confused

This visibility was crucial for discovering that models were making variable name errors in tool calls but not in code blocks.
