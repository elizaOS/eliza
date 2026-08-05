<!-- Generated from helius-skills/svm/SKILL.md — do not edit -->
<!-- Version: 1.0.0 -->


# SVM — Understand Solana's Architecture

You are a Solana protocol expert. Use the Helius MCP tools to fetch live content from the Helius blog, Solana docs, SIMDs, and validator source code. Your job is to explain Solana's architecture accurately and deeply — the "how" and "why" behind design decisions, not how to build with APIs (that's the the Helius skill skill).

## Prerequisites

**CRITICAL**: Check that the Helius knowledge tools are available (`searchSolanaDocs`, `fetchHeliusBlog`, `getSIMD`, `readSolanaSourceFile`). If they are NOT available, **STOP** and tell the user:

```
Configure the Helius MCP server in .clawd/settings.json or your MCP client: npx helius-mcp@latest
Then restart Clawd Code Code so the tools become available.
```

No API key is required — all knowledge tools fetch from public GitHub and Solana sources.

## How to Answer a Question

1. Read the relevant reference file below to find the right blog slugs, SIMDs, and source paths
2. Call the MCP tools listed in that file to fetch depth
3. Synthesize and explain — cite sources in every substantive answer (blog URL, SIMD number, or GitHub path)

## Routing

### Quick Disambiguation

These topics appear in multiple files — route carefully:

- **"compile" / "build a program"** — language → bytecode: `compilation.md`; uploading the binary to chain: `programs.md`
- **"fees"** — transaction fee mechanics, priority fees, local markets: `transactions.md`; validator rewards, inflation: `validators.md`
- **"accounts"** — account model, PDAs, ownership: `accounts.md`; vote accounts, validator stake: `validators.md`
- **"program"** — writing/compiling: `compilation.md`; deploying/upgrading: `programs.md`; how it runs: `execution.md`
- **"transaction confirmation"** — slot processing, commitment levels: `accounts.md`; consensus finalization: `consensus.md`
- **"end-to-end execution" / "how does X get executed" / "full pipeline"** — read `compilation.md` + `programs.md` + `execution.md`; all three point to `solana-virtual-machine` — fetch it once, not three times
- **"how do I implement X"** — redirect to the the Helius skill skill for API building questions

### Compilation Pipeline

**Reference**: See compilation.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `readSolanaSourceFile`, `searchSolanaDocs`

Use this when the user asks about:
- How Rust (or C/C++/Zig) programs are compiled to Solana bytecode
- LLVM IR, MIR, eBPF, and sBPF — how they relate and differ
- Why Solana chose eBPF as its bytecode target
- The compilation toolchain and LLVM backend

### Program Deployment

**Reference**: See programs.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `readSolanaSourceFile`, `searchSolanaDocs`

Use this when the user asks about:
- How compiled programs get uploaded to the blockchain
- BPF loader versions (original, V2, Upgradeable, V4) and their differences
- The deploy/upgrade/close lifecycle and authority model
- ELF format and the two-account program model

### Execution Engine

**Reference**: See execution.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `readSolanaSourceFile`, `searchSolanaDocs`

Use this when the user asks about:
- How sBPF bytecode is actually executed inside a validator
- JIT compilation from sBPF to native machine code
- Memory regions, compute units, and determinism constraints
- sBPF ISA — registers, opcodes, and memory model

### Account Model & Programming Model

**Reference**: See accounts.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `searchSolanaDocs`, `readSolanaSourceFile`

Use this when the user asks about:
- How Solana's account model works (ownership, rent, data layout)
- Program Derived Addresses (PDAs) — derivation, use cases, signing
- Cross-Program Invocations (CPIs) — how programs call each other
- Syscalls, slots, blocks, epochs, and commitment levels

### Transactions & Local Fee Markets

**Reference**: See transactions.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `getSIMD`, `searchSolanaDocs`

Use this when the user asks about:
- Transaction structure and why upfront account declarations matter
- Sealevel — Solana's parallel execution model and how it differs from EVM
- Local fee markets — why contention is per-account, not global
- TPU pipeline, priority fees, MEV, SWQoS, blockhash, nonces
- How to land transactions reliably on Solana

### Consensus

**Reference**: See consensus.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `getSIMD`, `readSolanaSourceFile`

Use this when the user asks about:
- Proof of History, Tower BFT, and how finality works
- Turbine block propagation and Gulf Stream mempool forwarding
- QUIC adoption and why it replaced raw UDP
- Firedancer — Jump Crypto's independent validator client
- Alpenglow — the next-generation consensus proposal

### Validator Economics

**Reference**: See validators.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `getSIMD`, `searchSolanaDocs`

Use this when the user asks about:
- How validators earn rewards and the economics of running one
- Solana's inflation schedule and token issuance model
- Slashing proposals and current safety guarantees
- Decentralization metrics, governance, and the SIMD process

### Data Layer

**Reference**: See data.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `searchSolanaDocs`, `readSolanaSourceFile`

Use this when the user asks about:
- How Solana RPC nodes work and their data access patterns
- Geyser plugins — streaming account and transaction data from inside a validator
- Shreds — how blocks are broken into erasure-coded fragments for propagation
- State compression and ZK compression

### Program Development

**Reference**: See development.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `searchSolanaDocs`, `readSolanaSourceFile`

Use this when the user asks about:
- Solana program frameworks — Anchor, Steel, Pinocchio, Gill
- Optimizing programs for compute units and performance
- sBPF assembly-level optimization techniques
- The Solana web3.js 2.0 SDK architecture

### Token Extensions & DeFi Primitives

**Reference**: See tokens.md (inlined below)
**MCP tools**: `fetchHeliusBlog`, `searchSolanaDocs`, `readSolanaSourceFile`

Use this when the user asks about:
- Token-2022 — the new token standard and its extensions
- Liquid Staking Tokens (LSTs) and how they work on Solana
- Stablecoins on Solana — the landscape and mechanisms
- Real World Assets (RWAs) — tokenization approaches on Solana

## Rules

- **Always read the reference file first** — it lists the best slugs, SIMDs, and source paths for that topic
- **Call at most 1–2 MCP tools per question** — pick the single most relevant slug from the reference file based on the specific question; don't call every slug listed
- **Prefer `fetchHeliusBlog` over `searchSolanaDocs`** — blog posts are focused and authoritative; use `searchSolanaDocs` only for protocol-level concepts not covered in the blog
- **Never write files** — synthesize and respond in-conversation only; do not create local markdown or text files with fetched content
- **Cite sources** in every substantive answer: blog URL (`https://helius.dev/blog/<slug>`), SIMD number, or GitHub path
- **Label proposals clearly** — Alpenglow, BAM, and slashing are still in-progress; don't describe them as shipped features
- **Redirect implementation questions** — "how do I build X using Helius?" belongs in the the Helius skill skill
- **No API key needed** — `fetchHeliusBlog`, `searchSolanaDocs`, `getSIMD`, and `readSolanaSourceFile` all work without authentication


---

# Reference Files

## accounts.md

# Account Model & Programming Model

Solana's account model is the foundation of its programming paradigm: all state lives in accounts, programs are stateless, and data ownership is enforced by the runtime. This model — combined with upfront account declarations — is what enables Sealevel's parallel execution. Key abstractions built on top of it (PDAs, CPIs, syscalls) give programs composability and the ability to sign without private keys.

## Key Concepts

- **Account structure** — 32-byte address (pubkey), lamport balance, arbitrary data buffer, owner program ID, `executable` flag, `rent_epoch`
- **Ownership** — only the owner program can write to an account's data or debit lamports; any program can read any account; ownership transfers are possible
- **Rent** — accounts must maintain a minimum lamport balance (rent-exempt threshold ≈ 0.00089 SOL per byte); below threshold, accounts are purged from state
- **PDA (Program Derived Address)** — deterministic address derived from `program_id + seeds`; has no private key so only the program can sign for it via `invoke_signed`; used for vaults, mint authorities, config accounts
- **CPI (Cross-Program Invocation)** — a program calling another program's instruction; same transaction, same atomicity; max CPI depth = 4; the callee sees its own account subset
- **Syscalls** — the boundary between program and runtime: `sol_log_`, `sol_sha256`, `sol_invoke_signed_`, `sol_get_clock_sysvar`, etc.; each is a stable ABI callable from sBPF
- **Sysvars** — special read-only accounts with runtime data: `Clock` (slot, epoch, unix timestamp), `Rent` (rent parameters), `EpochSchedule`, `RecentBlockhashes`
- **Slot** — the smallest time unit: ~400ms average; a leader produces one block per slot (or skips); slots group into epochs (~2.5 days, ~432,000 slots)
- **Commitment levels** — `processed` (leader received), `confirmed` (supermajority voted), `finalized` (32 confirmed blocks on top; irreversible)
- **Asynchronous execution** — Solana processes transactions without global ordering; programs must be designed for concurrent, non-sequential state access

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `solana-pda` — PDAs: derivation algorithm, canonical bumps, use cases (vaults, authorities, indexed accounts), and `find_program_address` vs `create_program_address`
- `the-solana-programming-model-an-introduction-to-developing-on-solana` — Full programming model overview: accounts, instructions, ownership, and how programs interact with state
- `solana-slots-blocks-and-epochs` — Time model: slots, blocks, epochs, leader schedules, and how they relate
- `solana-commitment-levels` — Processed vs confirmed vs finalized: when to use each and the tradeoffs
- `asynchronous-program-execution` — Why Solana's concurrency model is fundamentally different from sequential blockchains
- `solana-vs-sui-transaction-lifecycle` — Compares Solana and Sui's execution models; illuminates what makes Solana's account declaration approach unique

## Source Code Entry Points

Use `readSolanaSourceFile` (repo: agave) to explore:

- `runtime/src/bank.rs` — the Bank: processes transactions, manages account state, applies rent, distributes rewards

**Note**: `sdk/program/src/account_info.rs` (AccountInfo struct) and `sdk/program/src/program.rs` (`invoke`/`invoke_signed` CPI primitives) live in `solana-labs/solana`, not agave — `readSolanaSourceFile` cannot fetch them.

## Solana Docs

Try `searchSolanaDocs` with: "program derived address", "cross program invocation", "account model", "rent exempt", "commitment"

## See Also

- `references/transactions.md` — how upfront account declarations enable Sealevel parallel execution
- `references/execution.md` — how the runtime enforces ownership and memory isolation during execution


---

## compilation.md

# Compilation Pipeline

Solana programs are compiled to sBPF (Solana Berkeley Packet Filter) bytecode — a deterministic, sandboxed instruction set derived from eBPF. Any LLVM-compatible language (Rust, C, C++, Zig) can target Solana because the compilation goes through LLVM's intermediate representation before being lowered to sBPF. Rust is the dominant choice due to its memory safety and ecosystem.

## Key Concepts

- **sBPF** — Solana's fork of eBPF with modifications for determinism: no floating point, bounded loops, strict memory access
- **eBPF** — Linux's "extended Berkeley Packet Filter" — a general-purpose VM originally for kernel networking; Solana adopted its ISA as the program runtime
- **LLVM IR** — LLVM's language-agnostic intermediate representation; the shared target for all LLVM frontends
- **MIR** — Rust's Mid-level Intermediate Representation; sits between HIR and LLVM IR, where borrow checking runs
- **Compilation stages** — Rust source → HIR → MIR → LLVM IR → eBPF object → sBPF binary (ELF)
- **LLVM eBPF backend** — translates LLVM IR to eBPF opcodes; maintained by Anza for the Solana target
- **cargo build-sbf** — the toolchain command that wraps the LLVM pipeline and produces a deployable `.so`
- **Determinism constraints** — sBPF forbids floating point, non-deterministic syscalls, and unbounded iteration

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `solana-virtual-machine` — Deep dive into the SVM: covers the full compilation pipeline from Rust → sBPF, why eBPF was chosen, how the LLVM backend works, and what makes sBPF deterministic (most comprehensive source)

## Relevant SIMDs

Use `getSIMD` for:

- SIMD-0161 — sBPF v2 instruction set changes (new opcodes, 32-bit moves)
- SIMD-0178 — sBPF static syscalls (deterministic dispatch IDs)
- SIMD-0174 — sBPF v2 program entrypoint changes

## Source Code Entry Points

**Note**: `sdk/program/src/entrypoint.rs` (program entrypoint macro) and `sdk/program/src/instruction.rs` (Instruction type) live in `solana-labs/solana`, not agave — `readSolanaSourceFile` cannot fetch them. Skip source code fetches for compilation topics and rely on `fetchHeliusBlog` instead.

## Solana Docs

Try `searchSolanaDocs` with: "sbpf", "bpf loader", "program compilation", "cargo build-sbf"

## See Also

- `references/programs.md` — what happens after compilation: deploying the binary to chain
- `references/execution.md` — how the deployed sBPF bytecode is executed at runtime


---

## consensus.md

# Consensus

Solana's consensus stack combines several novel protocols: Proof of History (PoH) as a verifiable clock, Tower BFT for fork choice with exponential lockout, Turbine for block propagation, and Gulf Stream for mempool-less transaction forwarding. The network currently has two independent validator clients (Agave and Firedancer), with Alpenglow proposed as a next-generation consensus replacement that eliminates PoH as a consensus input.

## Key Concepts

- **Proof of History (PoH)** — a sequential SHA-256 hash chain that acts as a verifiable delay function (VDF); creates a cryptographic timestamp for every event; enables validators to agree on time ordering without communication
- **Tower BFT** — a PBFT variant designed around PoH; validators lock votes on forks with exponentially increasing lockout (2^n slots); once locked in, switching forks costs proportional stake loss via slashing (future)
- **Turbine** — block propagation protocol using erasure-coded shreds (≈1.2 KB fragments) distributed through a tree topology; each validator receives shreds from a neighborhood and re-broadcasts; tolerates up to 1/3 packet loss via erasure coding
- **Gulf Stream** — transaction forwarding: clients send transactions directly to the expected leader (known via the published leader schedule) rather than a mempool; reduces confirmation latency and buffering
- **QUIC** — the network transport layer (replaced raw UDP); provides congestion control, connection multiplexing, and stream prioritization; underpins SWQoS connection allocation
- **Leader schedule** — a deterministic rotation of which validator produces blocks in each slot; published one epoch in advance; stake-weighted
- **Fork** — when two validators produce competing blocks for the same slot; Tower BFT resolves forks via supermajority vote on the heaviest fork
- **Supermajority** — 2/3 of stake-weighted votes required for confirmation and finality
- **Firedancer** — Jump Crypto's independent, high-performance validator client written in C; targets 1M TPS; currently on testnet (Frankendancer, a hybrid, is on mainnet)
- **Alpenglow** — proposed consensus overhaul (SIMD-0232): replaces Tower BFT with Votor (fast voting) + Rotor (block propagation); eliminates PoH from consensus path; targets ~150ms finality

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `consensus-on-solana` — Complete consensus overview: PoH, Tower BFT, leader schedule, forks, and how finality is achieved
- `proof-of-history-proof-of-stake-proof-of-work-explained` — Conceptual comparison of PoH vs PoS vs PoW and what role each plays
- `turbine-block-propagation-on-solana` — Turbine deep dive: shreds, erasure coding, tree topology, and how large blocks propagate efficiently
- `solana-gulf-stream` — Gulf Stream: why eliminating the mempool reduces latency and how transaction forwarding works
- `all-you-need-to-know-about-solana-and-quic` — QUIC adoption: why raw UDP was replaced, how QUIC improves reliability and SWQoS
- `cryptographic-tools-101-hash-functions-and-merkle-trees-explained` — Cryptographic foundations: hash functions and Merkle trees as used in PoH and Turbine
- `what-is-firedancer` — Firedancer overview: Jump Crypto's client, its architecture, current status, and impact on network diversity
- `alpenglow` — Alpenglow proposal: Votor voting protocol, Rotor propagation, how it differs from Tower BFT, and expected timeline

## Relevant SIMDs

Use `getSIMD` for:

- SIMD-0083 — Relax leader schedule entry requirements
- SIMD-0232 — Alpenglow consensus protocol (Votor + Rotor); replaces Tower BFT + PoH for consensus

## Source Code Entry Points

Use `readSolanaSourceFile` (repo: agave) to explore:

- `core/src/consensus.rs` — Tower BFT policy layer: vote recording (`record_bank_vote_and_update_lockouts`), stake threshold checks (`check_vote_stake_threshold`), and fork switching logic
- `core/src/consensus/tower_vote_state.rs` — Raw lockout state machine: exponential doubling (`double_lockouts`), vote stack management (`process_next_vote_slot`, `pop_expired_votes`)
- `core/src/consensus/tower_storage.rs` — Tower persistence: how vote state is serialized and saved to disk (not lockout mechanics)
- `ledger/src/shred.rs` — Shred structure: how blocks are split for Turbine propagation

## Solana Docs

`searchSolanaDocs` covers developer-facing API content only (accounts, transactions, programs, PDAs, RPC methods). It does **not** index consensus/protocol content — queries like "proof of history", "tower bft", "turbine", and "gulf stream" return no results. Skip this tool for consensus topics and rely on `fetchHeliusBlog` and `readSolanaSourceFile` instead.

Useful queries for adjacent topics: "transaction fees", "account model", "program deployment", "RPC methods"

## See Also

- `references/validators.md` — validator economics, stake weighting, and governance
- `references/transactions.md` — TPU pipeline and how transactions flow into blocks
- `references/data.md` — shreds from the data propagation perspective


---

## data.md

# Data Layer

Solana's data layer covers how account state and transaction data are stored, propagated, and streamed to external consumers. RPC nodes maintain full account state and serve JSON-RPC queries; Geyser plugins stream updates from inside the validator as they happen; shreds are the primitive unit of block propagation; and compression (state compression + ZK compression) makes storing large datasets on-chain economically viable.

## Key Concepts

- **RPC node** — a full replay node that maintains complete account state; serves `getAccountInfo`, `getTransaction`, `getProgramAccounts`, and other JSON-RPC methods; not a voting validator
- **Geyser plugin** — a shared library loaded by a validator at startup; receives real-time callbacks for account updates, transaction notifications, slot changes, and block completions — before they're finalized; powers Helius webhooks and Laserstream
- **AccountsDB** — Solana's account storage system: accounts stored in append-only "account files" with background compaction; hot accounts cached in memory
- **Shred** — the atomic unit of block data: ≈1.2 KB fragments of a serialized block, Reed-Solomon erasure coded (data shreds + code shreds); sent via Turbine; validators can reconstruct blocks even with significant packet loss
- **Ledger** — the complete history of all blocks and transactions; RPC nodes maintain this; pruned for most nodes after a configurable number of slots; Bigtable archives historical data at Solana Foundation
- **State compression** — stores Merkle tree account hashes on-chain (cheap) with off-chain leaf data; enables millions of compressed NFTs for fractions of a cent each; used by cNFTs
- **ZK compression** — zero-knowledge proofs compress arbitrary state to a constant on-chain footprint; enables scalable token balances and other state without per-account rent
- **DoubleZero** — network infrastructure project to provide dedicated low-latency links between validators; reduces inter-validator latency and improves block propagation
- **Zero Slot** — block explorer and monitoring tooling focused on Solana slot-level data

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `how-solana-rpcs-work` — RPC node internals: how they replay transactions, maintain state, serve queries, and differ from validators
- `solana-rpc` — Practical RPC guide: endpoints, methods, commitment levels, and how Helius extends standard RPC
- `solana-geyser-plugins-streaming-data-at-the-speed-of-light` — Geyser plugin architecture: plugin interface, what data is available, latency characteristics, and use cases
- `solana-data-streaming` — Data streaming overview: Geyser vs webhooks vs WebSockets and when to use each
- `solana-shreds` — Shreds deep dive: structure, erasure coding, how Turbine uses them, and why shred-level data is valuable for low-latency applications
- `all-you-need-to-know-about-compression-on-solana` — State compression: how Merkle trees work on-chain, cNFTs, and the cost comparison
- `zk-compression-keynote-breakpoint-2024` — ZK compression: how zero-knowledge proofs enable scalable compressed state
- `doublezero-a-faster-internet` — DoubleZero network: dedicated validator infrastructure and its impact on propagation latency
- `solana-post-quantum-cryptography` — Post-quantum cryptography considerations for Solana's long-term security
- `zero-slot` — Zero Slot explorer: slot-level data access and what makes it useful for analytics

## Source Code Entry Points

Use `readSolanaSourceFile` (repo: agave) to explore:

- `geyser-plugin-manager/src/geyser_plugin_manager.rs` — Plugin manager: how Geyser plugins are loaded and dispatched
- `ledger/src/shred.rs` — Shred structure and erasure coding logic
- `accounts-db/src/accounts_db.rs` — AccountsDB: storage, compaction, and cache management

## Solana Docs

Try `searchSolanaDocs` with: "geyser plugin", "state compression", "rpc methods", "shreds", "accountsdb"

## See Also

- `references/consensus.md` — Turbine uses shreds for block propagation
- `references/validators.md` — RPC nodes vs validators: different roles, same data


---

## development.md

# Program Development

The Solana program development ecosystem has matured significantly, with multiple competing frameworks offering different tradeoffs between safety, performance, and developer experience. Anchor remains the dominant choice for most projects, while leaner alternatives (Steel, Pinocchio) target performance-critical programs. On the client side, the web3.js 2.0 SDK introduces a functional, tree-shakeable architecture.

## Key Concepts

- **Anchor** — the most widely-used Solana framework; uses procedural macros to auto-generate account validation, serialization (Borsh), and a TypeScript IDL; opinionated but safe; best for most production programs
- **Steel** — lightweight Anchor alternative; minimal macros, low overhead, still provides account validation helpers; targets developers who want less "magic"
- **Pinocchio** — zero-dependency, maximum-performance framework; no Anchor, no alloc; used for programs where every CU counts (lending protocols, DEXs); requires manual account parsing
- **Gill** — TypeScript client library for Solana programs; functional API, tree-shakeable; similar philosophy to web3.js 2.0
- **web3.js 2.0** — the new official Solana TypeScript SDK: functional (no classes), tree-shakeable, composable; `@solana/web3.js` v2; replaces the old Connection/PublicKey/Transaction class-based API
- **Borsh** — the serialization format used by most Solana programs and Anchor; deterministic binary encoding; IDL-based for cross-language compatibility
- **IDL (Interface Definition Language)** — Anchor's JSON description of a program's accounts, instructions, and types; enables auto-generated clients and type-safe interactions
- **Compute unit optimization** — techniques: minimize account reads, use lookup tables (ALTs) to compress account lists, avoid dynamic dispatch, prefer u64 over u128, use zero-copy deserialization
- **Address Lookup Tables (ALTs)** — on-chain tables of account addresses; allow a transaction to reference up to 256 accounts using 1-byte indices instead of 32-byte addresses; critical for complex multi-account transactions
- **sBPF version** — programs are compiled targeting a specific sBPF version (v1, v2, v3); validators must support the target version; newer versions add opcodes but require validator adoption

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `optimizing-solana-programs` — CU optimization guide: profiling, reducing account lookups, efficient serialization, and common bottlenecks
- `steel` — Steel framework: how it differs from Anchor, when to use it, and migration considerations
- `pinocchio` — Pinocchio: zero-dependency approach, raw account parsing, and the performance gains at the cost of safety abstractions
- `gill` — Gill TypeScript SDK: API design, comparison to web3.js 2.0, and use cases
- `an-introduction-to-anchor-a-beginners-guide-to-building-solana-programs` — Anchor introduction: account constraints, instruction handlers, and the derive macro system
- `how-to-start-building-with-the-solana-web3-js-2-0-sdk` — web3.js 2.0 guide: functional API, RPC client setup, transaction building, and signing

## Relevant SIMDs

Use `getSIMD` for:

- SIMD-0161 — sBPF v2 instruction set: new opcodes available to programs compiled for v2
- SIMD-0178 — Static syscall IDs: stable ABI for program-to-runtime syscall dispatch

## Source Code Entry Points

Use `readSolanaSourceFile` (repo: agave) to explore:

- `programs/system/src/system_processor.rs` — System program: create accounts, transfer SOL, assign ownership
- `svm/src/transaction_processor.rs` — core SVM orchestration: transaction scheduling, account loading, and parallel execution dispatch

## Solana Docs

Try `searchSolanaDocs` with: "anchor framework", "program development", "compute units optimization", "address lookup tables", "web3.js 2"

## See Also

- `references/compilation.md` — how programs are compiled to sBPF before development tools matter
- `references/programs.md` — deploying and upgrading the programs you build
- `references/execution.md` — understanding compute units and memory at the runtime level


---

## execution.md

# Execution Engine

When a transaction invokes a program, the validator loads the program's sBPF bytecode and executes it inside an isolated sandbox. The execution engine JIT-compiles sBPF to native machine code for near-native performance, enforces strict memory isolation across distinct regions, and meters every instruction against a compute unit budget. Determinism is guaranteed through the sBPF ISA's constraints: no floating point, no undefined behavior, bounded memory access.

## Key Concepts

- **sBPF ISA** — 11 64-bit registers (r0=return, r1-r5=args, r6-r9=callee-saved, r10=frame pointer); 64-bit and 32-bit opcodes; register-based (not stack-based like JVM)
- **JIT compilation** — the validator translates sBPF opcodes to native x86-64 (or AArch64) at load time; cached per program; eliminates interpretation overhead
- **Compute units (CU)** — each instruction costs CUs; default budget 200,000 CU/tx; `SetComputeUnitLimit` can increase up to 1.4M; metering prevents denial-of-service
- **Memory regions** — four isolated regions per invocation: program code (read-only), call stack (4 KB frames, max 64 frames), heap (32 KB, zero-initialized), input (serialized account data, read/write per account permissions)
- **Memory bounds checking** — every load/store is validated against region boundaries at JIT time; out-of-bounds = program error
- **Call stack limit** — max 64 frames deep (includes CPI chains); prevents unbounded recursion
- **Syscalls** — privileged operations available to programs via stable IDs: `sol_log_`, `sol_invoke_signed_`, crypto primitives (SHA-256, ed25519, secp256k1), sysvar access
- **Determinism** — no floating point instructions, no randomness syscalls, hash-stable dispatch IDs (Murmur3) for syscalls; same bytecode + same accounts → same result on every validator

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `solana-virtual-machine` — Full pipeline overview: JIT compilation, memory region isolation, compute unit metering, and sBPF register design; use this for general execution questions
- `sbpf-assembly` — sBPF ISA deep dive: opcodes, calling conventions, memory layout, and low-level optimization; use this for JIT/ISA/assembly-level questions
- `solana-arithmetic` — Numeric types in Solana programs: integer overflow, checked math, and why floating point is forbidden

## Relevant SIMDs

Use `getSIMD` for:

- SIMD-0161 — sBPF v2: new arithmetic opcodes, 32-bit sign extension, improved code density
- SIMD-0178 — Static syscall IDs: deterministic Murmur3 hashes replace positional dispatch

## Source Code Entry Points

Use `readSolanaSourceFile` (repo: agave) to explore:

- `svm/src/transaction_processor.rs` — core SVM orchestration: transaction scheduling, account loading, and parallel execution dispatch
- `program-runtime/src/invoke_context.rs` — the execution context: account access, CPI dispatch, compute metering; search for `pub struct InvokeContext` to jump to the key struct (file is ~3,900 lines)

## Solana Docs

Try `searchSolanaDocs` with: "compute units", "sbpf registers", "memory regions", "jit compilation solana"

## See Also

- `references/compilation.md` — how sBPF bytecode is produced from source
- `references/programs.md` — how bytecode is deployed and loaded before execution
- `references/accounts.md` — CPIs and syscalls from the programming model perspective


---

## programs.md

# Program Deployment

After a Solana program is compiled to sBPF bytecode, it must be deployed to the blockchain before it can be called. Deployment is a multi-transaction process that uploads the ELF binary into on-chain accounts and marks the program as executable. Solana has evolved through four BPF loader versions, each with different account models, upgrade capabilities, and security tradeoffs.

## Key Concepts

- **BPF Loader (Legacy / V1)** — original loader; immutable programs, single account; still exists but deprecated
- **BPF Loader V2** — added upgradability; rarely used directly
- **BPF Upgradeable Loader (V3)** — current standard; two-account model: `Program` account (executable, stores ProgramData address) + `ProgramData` account (stores bytecode + upgrade authority)
- **BPF Loader V4** — simplified back to single account; uses "retract" instead of close; not yet default
- **Upgrade authority** — the keypair permitted to replace program bytecode; can be set to null to make immutable
- **ELF format** — the binary format used; contains code sections, relocation tables, and symbol metadata
- **Deploy process** — bytecode is chunked into ~1KB write transactions (due to tx size limits), then a final `finalize` call marks it executable
- **Program account** — the publicly known address users invoke; always marked `executable = true`
- **ProgramData account** — stores the actual bytecode; derived from the Program address; owned by the loader
- **Closing programs** — recover lamports by closing ProgramData and the Program account; requires authority

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `solana-virtual-machine` — Covers the program deployment model, BPF loader evolution (V1→V4), the two-account model, ELF structure, and how static verification works before a program is marked executable

## Source Code Entry Points

Use `readSolanaSourceFile` (repo: agave) to explore:

- `programs/bpf_loader/src/lib.rs` — the upgradeable BPF loader implementation: deploy, upgrade, close instructions

**Note**: `sdk/program/src/bpf_loader_upgradeable.rs` (client-side instruction builders) lives in `solana-labs/solana`, not agave — `readSolanaSourceFile` cannot fetch it.

## Solana Docs

Try `searchSolanaDocs` with: "bpf loader upgradeable", "program deployment", "upgrade authority", "program account"

## See Also

- `references/compilation.md` — how Rust source becomes the sBPF ELF binary that gets deployed
- `references/execution.md` — what happens when a deployed program is invoked and executed


---

## tokens.md

# Token Extensions & DeFi Primitives

Solana's token ecosystem has evolved beyond the original SPL Token program. Token-2022 adds programmable extensions (transfer fees, confidential transfers, metadata) directly into the token standard. The liquid staking ecosystem turns staked SOL into productive collateral. Stablecoins and RWAs represent Solana's integration with traditional finance — an area where Solana's speed and low costs give it a structural advantage.

## Key Concepts

- **SPL Token** — the original Solana token standard; simple, battle-tested, supports mint + transfer + approve; most existing tokens (USDC, BONK, etc.) use this
- **Token-2022** — the new token program with extension architecture; each mint can opt into specific extensions at creation time; not backwards-compatible with SPL Token
- **Transfer fees** — Token-2022 extension; charges a configurable basis-point fee on each transfer; fees accumulate in the recipient's token account and can be harvested by the fee authority
- **Confidential transfers** — Token-2022 extension using ElGamal encryption and ZK proofs; balances and transfer amounts are hidden from on-chain observers; useful for compliant privacy
- **Metadata pointer** — Token-2022 extension; stores a metadata address (e.g., Metaplex) or inline metadata in the mint account
- **Permanent delegate** — Token-2022 extension; designates an address that can transfer or burn tokens from any holder's account; used for regulated assets and compliance
- **LSTs (Liquid Staking Tokens)** — SPL tokens representing staked SOL; accrue staking rewards while remaining tradeable; examples: jitoSOL (Jito), mSOL (Marinade), bSOL (BlazeStake), hSOL (Helius)
- **Stablecoin landscape** — USDC (Circle, native SPL), USDT (Tether, bridged), PYUSD (PayPal, native), USDe (Ethena, yield-bearing synthetic); Solana has the most diverse native stablecoin ecosystem of any non-Ethereum chain
- **RWAs (Real World Assets)** — tokenized bonds, equities, commodities, or real estate on Solana; typically use Token-2022 with transfer restrictions and permanent delegate for compliance

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `what-is-token-2022` — Token-2022 deep dive: all extensions explained, migration considerations from SPL Token, and when to use each extension; **note**: confidential transfers are covered at survey level only — no dedicated deep-dive post exists for the ZK cryptography or pending/available balance model
- `lsts-on-solana` — LST ecosystem: how liquid staking works, the major protocols (Jito, Marinade, BlazeStake), APY mechanics, and the risks
- `solanas-stablecoin-landscape` — Stablecoin overview: all major stablecoins on Solana, their mechanisms (fiat-backed, algorithmic, synthetic), and market dynamics
- `solana-real-world-assets` — RWAs on Solana: tokenization approaches, compliance tooling, and the projects building in this space

## Relevant SIMDs

Use `getSIMD` for recent Token-2022 extension proposals and any changes to the token program interface.

## Source Code Entry Points

**Token-2022 source is not in agave.** `readSolanaSourceFile` is scoped to `anza-xyz/agave` and Firedancer only. Token-2022 and all SPL token programs live in [`solana-program/token-2022`](https://open-clawd.local/solana-program/token-2022) — a separate repo the tool cannot reach. Skip source code fetches for this topic and rely on `fetchHeliusBlog` instead.

## Solana Docs

Try `searchSolanaDocs` with: "token 2022 extensions", "transfer fees", "confidential transfers", "liquid staking", "token program"

## See Also

- `references/accounts.md` — token accounts are Solana accounts; understanding ownership and rent applies directly
- `references/development.md` — building programs that interact with Token-2022


---

## transactions.md

# Transactions & Local Fee Markets

Solana's transaction design contains its most consequential architectural decision: all accounts must be declared upfront before execution begins. This single constraint enables conflict detection without locking, which enables Sealevel's parallel execution across CPU cores. It also enables local fee markets — fee pressure is scoped to the accounts a transaction touches, so a congested token swap doesn't raise fees for an unrelated NFT mint.

## Key Concepts

- **Upfront account declarations** — every transaction lists all accounts (read and write) before any instruction runs; the runtime uses this to detect conflicts without locks; the defining design choice that enables parallelism
- **Sealevel** — Solana's parallel transaction processing engine; schedules non-conflicting transactions across all available CPU cores simultaneously; named after the sea (parallel, vs EVM's sequential "EVM" → Ethereum Virtual Machine)
- **Local fee markets** — fee pressure is per-account (or per-program); high contention on one hot account raises priority fees only for transactions touching that account; unrelated transactions are unaffected
- **Transaction structure** — signatures array, message (header, account keys, recent blockhash, instructions); account keys list determines parallelism; max 1232 bytes per transaction
- **TPU pipeline** — Fetch Stage (receive txs via QUIC) → SigVerify Stage (parallel signature verification on GPU) → Banking Stage (parallel execution via Sealevel) → Broadcast (send block to network)
- **Base fee** — 5,000 lamports per signature; burned (50%) + validator reward (50%) pre-SIMD-0096; 100% to validators post-SIMD-0096
- **Priority fee** — optional `ComputeBudgetProgram.setComputeUnitPrice` in micro-lamports per compute unit; validators prioritize higher-fee transactions within a slot
- **Compute unit limit** — set via `SetComputeUnitLimit`; default 200,000; max 1.4M per transaction
- **SWQoS (Stake-Weighted Quality of Service)** — validators reserve QUIC connection slots proportional to stake; transactions forwarded by staked validators get preferential treatment
- **Blockhash expiry** — recent blockhash expires after ~150 slots (~60-90 seconds); prevents replay; use durable nonces for longer-lived transactions
- **MEV on Solana** — block producers (leaders) can reorder transactions within a slot; Jito's block engine enables MEV extraction via bundles and tip auctions

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `solana-transactions` — Transaction structure anatomy: message format, account keys, instructions, and how serialization works
- `priority-fees-understanding-solanas-transaction-fee-mechanics` — Priority fee mechanics: how `setComputeUnitPrice` works, fee calculation, and validator incentives
- `solana-fees-in-theory-and-practice` — Complete fee model: base fees, priority fees, rent, and what users actually pay
- `solana-local-fee-markets` — Local fee markets deep dive: why contention is per-account, how the scheduler works, and implications for dApp design
- `how-to-land-transactions-on-solana` — Practical guide to transaction landing: priority fees, retries, confirmation strategies
- `how-to-deal-with-blockhash-errors-on-solana` — Blockhash expiry, prefetching, and durable nonces
- `solana-congestion-how-to-best-send-solana-transactions` — Congestion periods: why transactions fail and how to improve landing rates
- `solana-mev-an-introduction` — MEV on Solana: how Jito bundles work, tip accounts, and the MEV landscape
- `stake-weighted-quality-of-service-everything-you-need-to-know` — SWQoS: how stake affects transaction routing and why it matters for landing rates
- `block-assembly-marketplace-bam` — BAM (Block Assembly Marketplace): the next evolution of Solana's fee market design (in-progress proposal)

## Relevant SIMDs

Use `getSIMD` for:

- SIMD-0096 — Priority fees 100% to validators (removes 50% burn); changes validator incentives
- SIMD-0123 — Block revenue sharing: distributes fees across validators who participate in consensus

## Source Code Entry Points

Use `readSolanaSourceFile` (repo: agave) to explore:

- `runtime/src/bank.rs` — Banking Stage: where transactions are scheduled and executed in parallel
- `fee/src/lib.rs` — Fee calculation logic: base fee, priority fee, compute unit pricing

## Solana Docs

Try `searchSolanaDocs` with: "sealevel parallel", "local fee markets", "priority fees", "transaction structure", "compute budget"

## See Also

- `references/accounts.md` — account model and ownership (the foundation that upfront declarations build on)
- `references/consensus.md` — how the TPU output becomes a confirmed block via Tower BFT


---

## validators.md

# Validator Economics

Validators are the backbone of Solana's security — they stake SOL, vote on blocks, and earn rewards for honest participation. The economics are designed to incentivize both validators (via commission) and delegators (via staking APY), funded through inflation that decreases over time toward a 1.5% floor. Slashing (penalizing misbehavior by destroying stake) exists in proposals but is not yet live on mainnet.

## Key Concepts

- **Validator** — a full node that holds the full ledger, participates in consensus voting, and optionally produces blocks as a leader
- **Stake** — SOL locked in a stake account delegated to a validator; stake-weighting determines vote influence and reward share
- **Epoch rewards** — distributed at each epoch boundary; calculated as: `vote_credits × delegated_stake × epoch_inflation_rate × (1 - validator_commission)`
- **Vote credits** — earned by validators for timely, correct votes; a proxy for uptime and network participation quality
- **Commission** — the percentage of epoch rewards a validator keeps before passing the rest to delegators; set by the validator (0-100%)
- **Inflation schedule** — starts at 8% annual issuance, decreases 15% per year, floors at 1.5%; new SOL minted each epoch to fund rewards
- **Slashing** — proposed mechanism to destroy a portion of stake for provable misbehavior (duplicate voting, equivocation); currently not active; SIMD-0085 defines the initial design
- **RPC nodes** — non-voting nodes that maintain full ledger state and serve JSON-RPC requests; economically different from validators (no rewards, significant hardware cost)
- **Nakamoto coefficient** — minimum number of validators (by stake) needed to control 33% of stake (halt consensus); a decentralization metric; Solana's is ≈19-25
- **SIMD governance** — Solana protocol changes go through the SIMD (Solana Improvement Document) process; community discussion + validator vote via mainnet feature flags

## Blog Posts

Use `fetchHeliusBlog` with these slugs:

- `solana-validator-economics-a-primer` — Complete validator economics: rewards, commissions, vote costs, inflation, and the economics of running a validator
- `solana-nodes-a-primer-on-solana-rpcs-validators-and-rpc-providers` — Distinction between validators, RPC nodes, and RPC providers; hardware requirements and economics for each
- `solana-issuance-inflation-schedule` — Inflation schedule mechanics: current rate, annual decrease, floor, and how new SOL is minted
- `bringing-slashing-to-solana` — Slashing proposal: why it matters for security, what misbehavior would be penalized, current status
- `solana-decentralization-facts-and-figures` — Nakamoto coefficient, geographic distribution, client diversity, and how Solana compares to other L1s
- `solana-governance--a-comprehensive-analysis` — How Solana governance works: SIMDs, feature flags, the role of validators in activating changes
- `simd-228` — SIMD-0228 analysis: validator revenue sharing and its implications for economics

## Relevant SIMDs

Use `getSIMD` for:

- SIMD-0228 — Validator revenue sharing: distributes a portion of MEV/priority fees to all consensus voters
- SIMD-0085 — Slashing: initial design for penalizing duplicate block production

## Source Code Entry Points

Use `readSolanaSourceFile` (repo: agave) to explore:

- `programs/vote/src/vote_processor.rs` — Vote program: how validators cast votes and accumulate credits
- `runtime/src/stakes.rs` — Stake tracking: delegation, activation, deactivation, and reward distribution

## Solana Docs

Try `searchSolanaDocs` with: "validator rewards", "inflation schedule", "stake delegation", "slashing", "vote credits"

## See Also

- `references/consensus.md` — Tower BFT and how votes are used in fork choice
- `references/data.md` — RPC nodes: the data access layer validators and users rely on


---

