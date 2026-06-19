# Solana Gym: Teaching AI to Navigate DeFi Through Reinforcement Learning

## Why We Built This

Large Language Models have gotten remarkably good at writing code. But how do we actually measure their ability to understand and interact with complex systems like blockchains? Traditional benchmarks fall short when it comes to evaluating a model's capacity to compose transactions, understand protocol interactions, and navigate the intricate world of DeFi.

Enter **Solana Gym** - a reinforcement learning environment where AI agents learn to interact with the Solana blockchain by discovering protocols and earning rewards for unique interactions. Think of it as a playground where models can demonstrate their understanding of blockchain protocols through action, not just code generation.

## Our Best Discovery: The Code Loop Explorer

After months of experimentation, we found that the simplest approach worked best. Our **Code Loop Explorer** achieves remarkable results:

- **34 unique instruction rewards** in a single run (Gemini 2.5 Flash)
- **60% transaction success rate** (best runs)
- Direct TypeScript code generation without complex parsing
- Immediate reward feedback driving learning

The magic? We let models write TypeScript code directly in response blocks, execute it against a sandboxed Solana validator (Surfpool), and provide immediate feedback. No complex multi-agent systems, no abstract skill libraries - just code, execution, and rewards.

```typescript
// Models learn to pack multiple instructions for maximum rewards
export async function executeSkill(blockhash: string): Promise<string> {
  const tx = new Transaction();
  // ... 20+ instructions packed into one transaction
  return tx.serialize().toString("base64");
}
```

## The Journey: Why Traditional Evals Failed Us

Before Solana Gym, we tried everything to evaluate LLMs on blockchain knowledge. Every approach hit fundamental roadblocks.

### 📊 Attempt 1: Tool Call Evaluations

We started by building unit tests for SendAI (solana-agent-kit) tool usage with GPT-4o-mini as the judge. The idea was simple: test if models could correctly use tools like `transfer_sol`, `swap_tokens`, `stake_sol`.

**Why It Failed Spectacularly**:
- **Hypersensitivity to Implementation**: Change a parameter name from `amount` to `lamports`? Every eval breaks.
- **No Ground Truth**: Tools like `jupiter_swap` build entire transactions internally. They only work on mainnet. How do you know if the swap would succeed without spending real money?
- **SDK Lock-in**: We were testing knowledge of ONE SDK's abstraction layer, not Solana itself
- **The Mainnet Problem**: Without Surfpool (which didn't exist yet), we were SOL - Shit Out of Luck

**Real Example**:
```python
# This "passes" the eval but would fail on chain:
model_calls_tool("jupiter_swap", {
    "from_token": "SOL",  
    "to_token": "USDC",
    "amount": 1.5,  # Is this SOL or lamports? Who knows!
    "slippage": 100  # Is this basis points or percent? SDK-dependent!
})
```

### 📚 Attempt 2: Q&A Knowledge Evals

Next, we looked at Q&A datasets (shoutout Lumo Labs for their dataset). Test models on questions generated from ground-truth documentation.

**Why It Also Failed**:
- **Subjective Scoring**: Is "A PDA is a program-derived address" better or worse than "PDAs let programs own accounts"? Both are correct!
- **Hallucination vs Creativity**: Models would give technically correct but overly creative answers
- **No Practical Signal**: A model could ace every question but fail to write a single working transaction

**Example Frustration**:
```
Q: "How do you create a token account?"
Model A: "Use createAssociatedTokenAccountInstruction"  ✓
Model B: "Call getOrCreateAssociatedTokenAccount"      ✓
Model C: "First derive the ATA address, then..."        ✓
All correct! Which is "better"? 🤷
```

### 💡 The Breakthrough: Surfpool + Voyager

When Surfpool launched (Q2 2024), everything changed. Finally, a sandboxed Solana that behaves like mainnet! But we still didn't know how to evaluate in this open world.

Then we found Voyager. The paper's key insight: **reward curiosity itself**. Don't test specific knowledge - test the ability to explore and discover.

**The Eureka Moment**:
- Every unique (program_id, instruction_discriminator) = 1 point
- No predetermined "correct" answers
- Models that understand Solana deeply will naturally discover more
- The blockchain becomes the judge

## Why This Matters for Blockchain Evaluation

### 1. **Action Over Analysis**

Instead of asking "Can you explain DeFi?", we ask "Can you interact with DeFi protocols?" The difference is profound. Models must understand:
- Transaction composition and signing
- Account relationships and PDAs
- Instruction data encoding
- Program interaction patterns

### 2. **Universal, Not SDK-Specific**

We're not testing if models know `solana-agent-kit` or `@coral-xyz/anchor`. We're testing if they understand Solana itself. Any SDK, any approach, any creative solution - if it works on chain, it scores.

### 3. **Immediate, Objective Feedback**

Every transaction either succeeds or fails. Every new instruction discovered adds to the score. There's no ambiguity in evaluation - the blockchain is the judge.

## What We Need From the Community

**Right now, we're basically just testing if models know @solana/web3.js.** That's not enough. We need YOUR help to build comprehensive evaluation suites for the entire Solana ecosystem.

### 🎯 The Vision: Protocol-Specific Mini-Environments

Every major protocol should have its own evaluation environment. Why? Because knowing how to transfer SOL is vastly different from understanding Kamino's lending markets or Drift's perpetuals.

**What Protocols Should Submit**:
1. **Custom System Prompts** with your protocol's concepts
2. **SDK Integration Examples** showing real usage patterns  
3. **Reward Functions** that measure protocol mastery
4. **Success Criteria** specific to your protocol

### 🏗️ Protocol Environments We Need

**DeFi Protocols** (each needs its own environment!):
- **Kamino**: Test obligation management, multi-asset lending, leverage loops
- **Drift**: Evaluate perpetuals trading, DLOB understanding, liquidations
- **Phoenix**: Assess limit order placement, market making strategies
- **Orca/Raydium**: Measure pool interaction, concentrated liquidity understanding
- **Jupiter**: Test aggregation logic, route optimization

**Infrastructure Protocols**:
- **Metaplex**: NFT minting, metadata, collections
- **Squads**: Multisig creation and management
- **Pyth**: Oracle price feed integration

### 🛠️ SDK Environments We Need

Different SDKs have different abstractions. We need environments for each:

**TypeScript/JavaScript**:
- **@solana/kit**: Modern, composable Solana development
- **@coral-xyz/anchor**: IDL-based program interactions
- **@metaplex-foundation/js**: NFT-specific operations

**Other Languages** (yes, we need these too!):
- **Rust**: Native Solana program interactions
- **Python**: solana-py, anchorpy ecosystems
- **Go**: gagliardetto/solana-go patterns

### 📝 Example: Kamino-Specific Environment

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

### 🎮 Why Protocol-Specific Rewards Matter

Generic instruction discovery only tells part of the story. Protocol-specific rewards measure if models actually understand your protocol:

**Kamino Rewards**:
- Deposit → Borrow → Repay cycle = **Understanding lending**
- Leverage loops = **Understanding capital efficiency**
- Liquidation execution = **Understanding risk**

**Drift Rewards**:
- Open → Modify → Close position = **Understanding perps**
- Place limit orders on DLOB = **Understanding orderbook**
- Execute JIT liquidity = **Understanding MEV**

**Phoenix Rewards**:
- Place bid/ask spreads = **Understanding market making**
- Cancel and replace orders = **Understanding order management**
- Consume liquidity efficiently = **Understanding execution**

### 🚀 The Multiplication Problem (Help Needed!)

If we need:
- **10 protocols** × **3 SDKs** × **3 languages** = **90 unique environments**

...we're probably doing something wrong. This is a HUGE unsolved challenge that someone from the community could tackle.

**What We've Tried**:
- **program_ids.csv**: We tagged 100+ programs in `data/program_ids.csv` - but models struggle to use this effectively
- **fetchTransactions**: Added to `simple_explorer.py` so models could learn from existing transactions - but it's fragile
- **Generic exploration**: Works for System/Token programs, fails for complex protocols

**What Might Work Better**:
- **"Raw" Environments**: Force models to build everything from scratch with ONLY @solana/web3.js
- **Auto-discovery from IDLs**: Automatically generate rewards from program IDLs
- **Transaction Mining**: Learn protocol patterns from historical transactions
- **Cross-protocol transfer**: Can knowledge of one DEX help with another?

This is an open research problem. If you solve this, you've cracked protocol-agnostic evaluation.

### 🔧 How to Build Your Protocol Environment

1. **Fork our template**:
```bash
cp code_loop_explorer.py protocols/your_protocol_explorer.py
```

2. **Add your protocol's concepts**:
- System prompts with your terminology
- SDK examples from your docs
- Common patterns and gotchas

3. **Design reward functions**:
- What indicates basic understanding?
- What shows advanced mastery?
- What would impress your protocol team?

4. **Test with multiple models**:
- Ensure it's not too easy or too hard
- Verify rewards align with actual understanding

5. **Submit your PR**:
- Include sample runs
- Document what your rewards measure
- Explain why these metrics matter

### 🔬 Open Research Challenge: Protocol-Agnostic Discovery

The holy grail would be an environment where models can discover and interact with ANY protocol without protocol-specific prompts. Here's what makes this hard:

**The Discovery Problem**:
```python
# We have this in data/program_ids.csv:
"JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Jupiter v6"
"CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium CLMM"

# But models can't figure out:
# - What instructions these programs accept
# - What accounts they need
# - How to construct valid transactions
```

**Why fetchTransactions() Isn't Enough**:
- Transactions show WHAT happened, not WHY
- Account relationships are opaque without context
- Instruction data is just bytes without an IDL

**Dream Contribution**: A system that can:
1. Take any program ID
2. Fetch its IDL (if available) or reverse-engineer from transactions
3. Generate exploration strategies
4. Create meaningful rewards without human intervention

**🔥 Concrete Research Ideas**

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

## What Didn't Work (And Why That's Important)

### ❌ Tool Calling in Simple Explorer

**The Problem**: We built `simple_explorer.py` using OpenAI's function calling paradigm, where the model would invoke tools like:

```python
tools = [
    {"name": "executeSkill", "parameters": {"skill_name": "..."}},
    {"name": "writeSkillAndExecute", "parameters": {"skill_name": "...", "skill_code": "..."}},
    {"name": "fetchTransactions", "parameters": {"program_id": "..."}},
    {"name": "getObservation", "parameters": {}},
    {"name": "getProgramIdl", "parameters": {"program_id": "..."}}
]
```

**Why It Failed**:

- **Variable Name Errors**: When generating code as a JSON parameter, models constantly made typos - `agent_pubkey` became `agentPubkey`, `blockhash` became `blockHash`, etc. This NEVER happens in markdown code blocks!
- **String Escaping Hell**: Code in JSON parameters needed escaped quotes, escaped newlines - models would forget, break the JSON, and couldn't debug it
- **Lost TypeScript Errors**: When code failed, models saw generic tool errors instead of the actual TypeScript compiler output
- **Fighting the Natural Interface**: Models are already trained to write code in markdown code blocks!

**Real Example of What Happened**:

```json
// Model would generate this as a tool call:
{
  "name": "writeSkillAndExecute",
  "parameters": {
    "skill_name": "transfer_sol",
    "skill_code": "export async function executeSkill(blockhash: string): Promise<string> {\n  const tx = new Transaction();\n  const agentPubKey = new PublicKey('...');  // WRONG: agentPubKey vs agentPubkey\n  tx.add(SystemProgram.transfer({\n    fromPubkey: agentPubKey,  // WRONG: mixed casing\n    toPubkey: agentPubKey,\n    lamports: 100000\n  }));\n  tx.recentBlockHash = blockhash;  // WRONG: recentBlockHash vs recentBlockhash\n  return tx.serialize({requireAllSignatures: false}).toString(\"base64\");  // WRONG: unescaped quotes\n}"
  }
}
```

Every single tool call had these issues. But when the same model writes in a code block? Perfect every time:

```typescript
export async function executeSkill(blockhash: string): Promise<string> {
  const tx = new Transaction();
  const agentPubkey = new PublicKey("..."); // Correct!
  tx.add(
    SystemProgram.transfer({
      fromPubkey: agentPubkey, // Consistent!
      toPubkey: agentPubkey,
      lamports: 100000,
    })
  );
  tx.recentBlockhash = blockhash; // Correct property name!
  return tx.serialize({ requireAllSignatures: false }).toString("base64"); // No escaping needed!
}
```

**The Breakthrough Realization**: LLMs already know how to write code! They do it millions of times in training data using ```typescript blocks. Why force them through a different interface?

### ❌ Voyager-Style Skill Library and Code Reuse

**The Problem**: The original Voyager paper achieved great results by building a library of reusable skills in Minecraft. We implemented the same approach with TypeScript skills for Solana:

```typescript
// Skill: "transfer_sol"
async function transferSol(from: PublicKey, to: PublicKey, amount: number) {
    // ... implementation
}

// Later: "complex_defi_operation"
async function complexDefiOp() {
    await transferSol(...);  // Reuse previous skill
    await swapTokens(...);   // Reuse another skill
}
```

**Why It Failed for Blockchain**:

- **Transaction Atomicity**: Each Solana transaction needs ALL instructions in a single Transaction object. You can't compose by calling separate functions sequentially
- **Signature Requirements**: Every transaction needs specific signers. Reusable functions with hardcoded signers don't work
- **Context Dependency**: Each transaction depends heavily on current state (blockhash, account balances, program states)
- **No Real Skill Hierarchy**: Unlike Minecraft where "chop wood" → "craft planks" → "build house", Solana transactions are unique compositions

**What Actually Happened**:

```typescript
// Models kept generating this (WRONG):
await executeSkill1();
await executeSkill2(); // Separate transactions - not what we want!

// Instead of this (RIGHT):
const tx = new Transaction();
tx.add(instruction1, instruction2, instruction3); // All in one transaction
```

**RAG Retrieval Was Useless**:

- Retrieved "similar" skills that had completely different account structures
- Transaction patterns don't generalize well across different protocols
- Models spent more time trying to adapt retrieved code than writing fresh code

### ❌ Multi-Agent Architecture Complexity

**The Problem**: We faithfully implemented Voyager's multi-agent system:

- **Action Agent**: Generates code based on current state
- **Curriculum Agent**: Decides what task to pursue next
- **Critic Agent**: Evaluates if tasks were completed successfully
- **Skill Manager**: Stores and retrieves skills

**Why It Failed**:

- **Context Window Explosion**: Each agent needed full history, tool definitions, examples
- **Agent Coordination Overhead**: Agents waiting for each other, parsing each other's outputs
- **Debugging Impossibility**: Models couldn't see the full flow of what was happening
- **Lost in Translation**: Each agent interaction was another opportunity for misunderstanding

**Specific Failure Mode**:

```python
# Curriculum says: "Explore Token-2022 program"
# Action generates: Code for regular Token program
# Critic evaluates: "Success! Interacted with token program"
# Result: Misaligned objectives, no learning
```

### ❌ Complex AST Parsing with Babel

**The Problem**: In `action.py`, we used Babel to parse JavaScript/TypeScript from AI responses:

```python
babel_generator = import_module("@babel/generator")
parsed = babel.parse(code_string)
# Extract function node, validate structure, extract body...
```

**Why It Failed**:

- **Fragile Parsing**: Slight variations in generated code would crash everything
- **Incomprehensible Errors**: "TypeError: this.m[ffid] is not a function" - how is a model supposed to debug this?
- **Context Waste**: Error messages about AST nodes instead of actual code issues
- **Platform Hell**: Node.js/Babel version mismatches across environments

**Real Example That Broke Everything**:

```javascript
// Model generated this (note the comment):
export async function executeSkill(
    blockhash: string  // the blockhash parameter
): Promise<string> {
```

Parser exploded because of the inline comment. Model's response? Generate the same code again because it looked correct (it was!).

### 🎯 The Ultimate Lesson: Get Out of the Way

After all these failed attempts, we realized the fundamental truth:

**LLMs already know how to write code in a natural way - using markdown code blocks.**

```typescript
// This is how models write code in ChatGPT, Claude, GitHub Copilot, everywhere!
```

Why did we think we needed anything else?

The **Code Loop Explorer** succeeds because it:

1. Lets models write code exactly as they do in their training data
2. Extracts it with a simple regex: ` ```typescript(.*?)``` `
3. Executes it immediately
4. Returns clear success/failure feedback
5. Repeat

**No tools. No agents. No parsers. No abstractions.**

Just code → execution → feedback. The same loop developers use every day.

The best interface for getting code from LLMs isn't an interface at all - it's getting out of their way and letting them write code the way they already know how.

## Surprising Discoveries

### 🎯 Model Performance Varies Wildly

- **Gemini 2.5 Flash**: King of exploration, consistently high rewards
- **Qwen3 Coder**: Struggles with code loops but great at following examples
- **Grok 3 Mini**: Surprisingly effective despite being a smaller model
- **GPT-4o-mini**: Reliable but conservative in exploration

### 🎯 Starting Simple Beats Starting Complex

Models that begin with 2-3 known-working instructions and gradually scale up to 20+ instructions per transaction consistently outperform those that try complex interactions immediately.

### 🎯 Error Messages Are Teaching Moments

The immediate feedback from failed transactions teaches models faster than any prompt engineering. They quickly learn:

- Don't duplicate ComputeBudgetProgram instructions
- Always sign with new Keypairs
- Token-2022 has more instruction variety than Token

## Future Directions

### 🚀 Fine-Tuning on Successful Trajectories

We're collecting thousands of successful transaction trajectories. Imagine fine-tuning models specifically on:

- High-reward exploration paths
- Protocol-specific interaction patterns
- Error recovery strategies

### 🚀 MCP (Model Context Protocol) Integration

Integrating with Anthropic's MCP to provide:

- Real-time blockchain state as context
- Direct transaction submission tools
- Protocol documentation access

### 🚀 Multi-Chain Expansion

- **EVM Chains**: Ethereum, Arbitrum, Base
- **Move Chains**: Aptos, Sui
- **Cosmos**: Osmosis, Injective

### 🚀 Adversarial Environments

- MEV extraction challenges
- Liquidation bot competitions
- Arbitrage discovery tasks

### 🚀 Human-in-the-Loop Exploration

- Collaborative exploration where humans guide AI
- Teaching models through demonstration
- Reward shaping through human feedback

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

### 📊 Metrics and Traces

Every run generates detailed traces in `metrics/` and `traces/`:
- Transaction success/failure patterns
- Reward progression over time
- Which programs and instructions were discovered
- Error frequencies and types

## How to Contribute

### Getting Started

1. **Fork the repo**: [github.com/your-org/solana-gym](https://github.com/your-org/solana-gym)
2. **Pick a protocol**: Choose one you know well
3. **Create your environment**: Use our template as a starting point
4. **Test with multiple models**: Ensure it works across different LLMs
5. **Submit a PR**: Include example runs and performance metrics

### What Makes a Great Contribution

✅ **Clear, Protocol-Specific Prompts**: Models should understand what they're exploring

✅ **Comprehensive SDK Examples**: Real code that works on mainnet

✅ **Meaningful Reward Shaping**: Incentivize learning the protocol deeply

✅ **Documentation**: Explain why your approach teaches models effectively

✅ **Evaluation Metrics**: Show how different models perform

### Join the Community

- **Discord**: [discord.gg/solana-gym](https://discord.gg/solana-gym)
- **Twitter**: [@solana_gym](https://twitter.com/solana_gym)
- **Weekly Calls**: Thursdays 3pm UTC

## The Bigger Picture

We're not just building another benchmark. We're creating a framework for understanding how AI agents can autonomously navigate complex, adversarial environments. Blockchains are the perfect testbed because:

1. **Objective Truth**: Transactions either succeed or fail
2. **Compositional Complexity**: Infinite ways to combine instructions
3. **Real Stakes**: These models will eventually manage real assets
4. **Rapid Innovation**: New protocols launch daily

The models that excel in Solana Gym today will be the foundation for autonomous agents that can:

- Manage DeFi portfolios
- Execute complex trading strategies
- Audit smart contracts through interaction
- Discover protocol vulnerabilities
- Optimize gas and compute usage

## Call to Action

The best evaluation framework for blockchain AI won't come from a single team - it needs the collective expertise of the entire ecosystem. Whether you're a:

- **Protocol Developer**: Help us understand your protocol's nuances
- **DeFi Researcher**: Design reward functions that capture real value
- **AI Engineer**: Optimize the exploration algorithms
- **Blockchain Educator**: Create prompts that teach effectively

There's a place for you in Solana Gym.

## Acknowledgments

This project builds on the incredible work of:

- NVIDIA's Voyager team for the foundational paper
- The Surfpool team for the sandboxed Solana environment
- LangGraph for providing invaluable debugging visibility
- The Solana Foundation for ecosystem support
- All the protocol teams whose SDKs make this possible

---

_Solana Gym is open source and MIT licensed. We believe the future of blockchain AI should be built in the open._

**Ready to contribute?** Start with our [Code Loop Explorer example](./code_loop_explorer.py) and build your own protocol-specific environment. The future of blockchain AI evaluation is in your hands.

---

_Join us in building the definitive framework for evaluating AI's understanding of blockchains. Because the best way to test if a model understands DeFi is to let it play in the sandbox._
