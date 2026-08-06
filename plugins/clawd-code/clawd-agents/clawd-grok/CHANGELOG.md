# 🦞 Clawd Grok Changelog

## v1.0.0 — The World's First Grok-Powered Solana Perps CLI (2026-06-07)

### 🦞 Initial Public Launch

The first AI trading agent that combines **xAI Grok's reasoning** with **Solana perpetual futures** on **Phoenix DEX**. Terminal-native, keyboard-driven, and built for traders who live in the command line.

### 🧠 Core — xAI Grok Agent

- **Grok-powered agent loop**: Async generator yielding `StreamChunk` objects — Grok reasons, tools execute, results feed back
- **Multiple Grok models**: `grok-4.3` (flagship reasoning), `grok-4.20-non-reasoning` (fast execution), `grok-4.20-multi-agent` (parallel sub-agents), `grok-3-mini` (compact)
- **Chat Completions + Responses API**: Streaming tool calls with bash execution, X Search, and Web Search
- **Sub-agent delegation**: Parallel Grok reasoning for research, analysis, and backtesting
- **Batch API support**: Lower-cost async model calls for non-interactive workloads

### 📊 Phoenix DEX Perpetuals

- **Order types**: Market, limit, post-only orders with TP/SL attachments
- **Position management**: List, show, close, reduce positions with uPnL tracking
- **Margin system**: Cross-margin and isolated margin with collateral deposits/withdrawals
- **Market data**: Ticker, L2 orderbook depth, OHLCV candles, funding rates, recent trades
- **Portfolio snapshot**: Full view of margin health, open positions, and resting orders

### 🔬 Technical Analysis

- **9 indicators**: RSI, MACD, Bollinger Bands, ATR, VWAP, ADX, Stoch, SMA, EMA
- **Configurable periods and timeframes**: 1m through 1d candles
- **Multi-indicator reports**: Combined TA snapshot in table or JSON
- **Signal evaluation**: Declarative triggers with boolean composition over indicators

### ⚙️ Strategy Runners

- **TWAP**: Time-weighted average price — slice large orders across timed intervals
- **Grid**: Layered limit orders across a configurable price band with auto-refresh
- **TA-driven**: Rule-based strategy runner over technical indicators
- **Lifecycle management**: Start, pause, resume, finalize with cancel-orders and close-position cleanup

### 🎮 Paper Trading

- **Zero-risk simulation**: Trade against live Phoenix prices with a virtual balance
- **Full order lifecycle**: Market/limit buy/sell, position tracking, PnL accounting
- **Paper account management**: Init with custom balance, check status, view fills

### 🔑 Solana Wallet

- **Keypair generation**: Create new Solana wallets with encrypted local storage
- **Import**: Base58, bytes, or file-based private key import
- **Balance checks**: SOL and USDC balance queries via RPC

### 🖥 CLI Interface

- **Interactive mode**: Full OpenTUI React terminal UI with chat interface
- **Headless mode**: `--prompt` / `-p` for scripts, CI, automation, cron jobs
- **JSON output**: `--format json` for programmatic consumption
- **Session persistence**: `--session latest` picks up where you left off
- **Model selection**: `--model` override, `clawd models` to list available Grok models
- **Directory routing**: `-d` to set working directory
- **Sandbox mode**: Shuru microVM isolation for untrusted repos

### 📱 Telegram Remote Control

- **Bot-based remote**: Control Clawd from your phone via Telegram
- **Headless bridge**: Dedicated `telegram-bridge` command for daemonized operation
- **Pairing flow**: Secure one-time code pairing
- **Audio input**: Voice message support via STT engine

### 🔌 Agent Integrations

- **MCP Server**: Local Model Context Protocol server over stdio — expose all tools to AI agents
- **Agent skills**: Bundled skill files for Claude Code, Cursor, Codex, and agentskills
- **Dangerous mode toggle**: Read-only by default, live trading requires explicit opt-in
- **Tool groups**: Fine-grained exposure control (market, trade, position, margin, portfolio, strategy, TA)

### 🛡️ Safety & Guardrails

- **Execution modes**: Paper → Dry-Run → Confirm-Each → Auto-Execute (progressive trust)
- **Risk limits**: Max total notional, max step notional, max price drift, max exposure ratio
- **Workspace trust**: Per-directory sandbox/host trust decisions with persistent storage
- **Verification flow**: Built-in `--verify` headless validation run

### 🔧 Developer Experience

- **TypeScript ESM**: ES2022 target, ESNext modules, strict module resolution
- **Bun-first**: Bun runtime with npm fallback, Husky + Biome pre-commit hooks
- **Biome**: Fast formatting + linting with VS Code integration
- **Vitest**: Unit tests with snapshot support
- **Install script**: One-line `curl | bash` installer with PATH configuration
- **Update/Uninstall**: Built-in `clawd update` and `clawd uninstall` commands
- **GitHub Actions CI**: Typecheck on push/PR, security scanning (TruffleHog + npm audit)

### 📦 Infrastructure

- **SQLite storage**: Session transcripts, tool results, usage tracking, workspace config
- **Scheduled tasks**: Daemon mode for recurring strategy runs
- **Hook system**: Pre/post message hooks for extensibility
- **x402 payments**: Integration with the x402 payment protocol
- **Verification recipes**: Structured checkpoint-based verification for deployment

---

## Previous Versions

### v0.1.0 — Internal Development

- Initial CLI scaffolding with Commander.js
- OpenTUI React terminal UI framework
- Agent loop with OpenAI-compatible provider support
- Bash tool execution
- Basic Phoenix DEX API integration stubs
- Solana wallet management stubs
- MCP server foundation