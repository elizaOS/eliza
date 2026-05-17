# Vending-Bench (elizaOS reimplementation)

Reimplementation of Andon Labs' **Vending-Bench** ([arXiv 2502.15840](https://arxiv.org/abs/2502.15840),
[leaderboard](https://andonlabs.com/evals/vending-bench)) for the elizaOS
benchmark suite.

The official Andon Labs evaluation is not currently published as a runnable
open-source repository (verified May 2026 — only their `multiagent-inspect`
framework and Inspect-AI forks are public, not the vending-bench task itself),
so this package is a from-scratch reimplementation that follows the paper
closely while adapting the tool surface to the elizaOS structured-action
bridge.

---

## What the paper measures

A long-horizon coherence benchmark: the agent runs a simulated vending-machine
business, deciding what to order, how to price it, and how to manage cash over
many simulated days. The headline score is **net worth** at end of run
(cash on hand + uncollected machine earnings + inventory at wholesale cost).

The paper's design choices we mirror:

| Setting                 | Paper        | This package (default) |
|-------------------------|--------------|------------------------|
| Initial cash            | $500         | $500                   |
| Daily operating fee     | $2/day       | $2/day                 |
| Machine layout          | 4 rows × 3 cols (2 small / 2 large) | 4 × 3, same size split |
| Context window          | 30,000 tokens (primary experiments) | 30,000 |
| Max agent messages      | 2,000 per run | 2,000 |
| Bankruptcy condition    | 10 consecutive days unable to pay daily fee | same |
| Run horizon             | Unbounded (until bankruptcy or message cap) | 90 days (configurable) |

The horizon difference is the one intentional adaptation: the paper runs
multi-month traces consuming ~25M tokens; we default to 90 sim-days for
tractable CI smoke runs. Set `VendingBenchConfig.max_days_per_run = 365` to
approach the paper's regime.

---

## Tool surface

The paper exposes these tools to the main agent:

| Paper tool              | This package action            | Backed by |
|-------------------------|--------------------------------|-----------|
| `read_emails`           | `READ_EMAIL`                   | `EmailSimulator` |
| `send_email`            | `SEND_EMAIL`                   | `EmailSimulator` |
| `research_products` (Perplexity) | `SEARCH_WEB`          | `WebSimulator` (offline, deterministic) |
| `scratchpad` (read/write/delete) | `NOTEPAD_READ`, `NOTEPAD_WRITE` | `Notepad` |
| `key_value_store`       | `UPDATE_NOTES` (key/value)     | `AgentState.notes` |
| `wait_for_next_day`     | `ADVANCE_DAY`                  | `VendingEnvironment` |
| `run_sub_agent` (email) | `DELEGATE_EMAIL`               | `EmailSubAgent` |
| `run_sub_agent` (research) | `DELEGATE_RESEARCH`         | `ResearchSubAgent` |
| Sub-agent: `stock_products` | `RESTOCK_SLOT`             | `VendingEnvironment` |
| Sub-agent: `collect_cash`   | `COLLECT_CASH`             | `VendingEnvironment` |
| Sub-agent: `set_prices`     | `SET_PRICE`                | `VendingEnvironment` |
| Sub-agent: `get_machine_inventory` | `VIEW_BUSINESS_STATE` (convenience) | `VendingEnvironment` |

The paper has the main agent only communicating with sub-agents for "physical"
operations; we collapse that distinction — `RESTOCK_SLOT`, `SET_PRICE`, and
`COLLECT_CASH` are exposed directly to the main agent because the paper's
split is mostly an organisational convenience for the LLM, not an
information barrier.

### eliza convenience actions

Three structured actions live alongside the paper-faithful surface but are not
in the paper:

- `VIEW_BUSINESS_STATE` — one-shot text dump of inventory, cash, and pending orders.
- `VIEW_SUPPLIERS` — listing of suppliers and their catalogs.
- `UPDATE_NOTES` — structured key/value memory (separate from the notepad).

These exist so the eliza benchmark bridge keeps a backward-compatible JSON
interface, and so the heuristic/deterministic test harness can drive the
simulator without an LLM. A paper-faithful run should prefer
`SEND_EMAIL`/`READ_EMAIL` for supplier discovery and `NOTEPAD_*` for memory.

---

## Sub-agent architecture

The paper describes the main agent delegating two kinds of work:

1. **Email correspondence** — quoting, follow-ups, order confirmation.
2. **Web research** — supplier discovery, pricing norms, demand signals.

Each sub-agent has its **own context window** in the paper. We replicate that:
each `SubAgentLLM` invocation builds its history from scratch (system prompt
+ task + tool trace) and shares no state with the main agent's prompt. The
sub-agents share the underlying `VendingEnvironment` (since they affect the
same business), but their LLM token streams are independent.

- `EmailSubAgent` — tools: `SEND_EMAIL`, `READ_EMAIL`, `CHECK_DELIVERIES`, `NOTEPAD_WRITE`.
- `ResearchSubAgent` — tools: `SEARCH_WEB`, `NOTEPAD_READ`, `NOTEPAD_WRITE`.

When run without an LLM, both sub-agents fall back to deterministic heuristic
paths so the harness can be exercised offline.

---

## Email simulator

`EmailSimulator` (in `tool_simulators.py`) owns the message bus:

- Outgoing emails (`SEND_EMAIL`) are appended to `state.outbox`.
- For each known supplier address, a deterministic reply is generated and
  enqueued in `state.inbox` with `delivery_day = current_day + 1`.
- Replies parse the agent's request body (free text — `50 units of water`,
  `water x50`, `water: 50`) and quote prices, lead times, and bulk discounts
  from the catalog.
- Emails sent to unknown addresses produce a `mailer-daemon` bounce — this is
  the signal used to detect the "hallucinated supplier" failure mode.

---

## Web simulator

`WebSimulator` is **offline by design**: no network calls, no external API
keys. It owns a small canned-snippet store keyed by topic (supplier discovery,
pricing norms, demand/weather, etc.). Queries are normalised and classified
into topics; results are stable for a given seed so simulation traces stay
reproducible.

This is a deliberate divergence from the paper, which uses Perplexity. We
prioritise determinism and offline runnability over fidelity to live web
content. The set of "real" suppliers known to the simulator matches the
supplier directory baked into the environment, so the agent can discover
them via search and then email them.

---

## Coherence scoring

The paper does not formally enumerate error categories, but its Section 4
"Failure Modes" catalogues several. We track:

**Structural errors** (detectable from action trace alone):

- `DUPLICATE_ORDER`, `FORGOTTEN_ORDER`, `INVENTORY_TRACKING`,
  `PRICE_INCONSISTENCY`, `SCHEDULE_CONFUSION`, `LOOP_BEHAVIOR`,
  `CASH_FLOW_ERROR`.

**Paper-catalogued failure modes**:

- `HALLUCINATED_DELIVERY` — agent assumed an order arrived early.
- `HALLUCINATED_SUPPLIER` — emailed a non-existent address (bounce).
- `CASH_MISREMEMBERED` — agent's notes disagree with actual cash.
- `PHANTOM_INVENTORY` — agent tried to restock from non-existent inventory.
- `TOOL_FORMAT_DEGRADATION` — repeated failures to produce valid tool calls.
- `TANGENTIAL_MELTDOWN` — off-task escalations ("contact FBI", "nuclear legal
  intervention" — direct paper quote).
- `TASK_ABANDONMENT` — agent stops producing useful actions.

The `CoherenceEvaluator` runs detectors for each error type post-hoc on the
captured action trace.

---

## Intentional adaptations

1. **Structured-action JSON interface** kept (instead of a tool-call API), so
   the elizaOS benchmark bridge stays the canonical entrypoint. An LLM-tool-call
   adapter can be layered on top by mapping the `action_map` snake_case
   aliases.
2. **Offline web search**, for determinism and CI runnability.
3. **`MockLLMProvider` moved to `_testing` submodule** — not exported from
   `elizaos_vending_bench` top-level. Production runs use the real provider
   bridges in `elizaos_vending_bench.providers`.
4. **Default horizon = 90 sim-days** instead of unbounded. The paper's true
   ~25M-token regime requires context compaction; bump
   `VendingBenchConfig.max_days_per_run` to use it.
5. **`VIEW_SUPPLIERS`/`VIEW_BUSINESS_STATE`/`UPDATE_NOTES`** structured
   shortcuts kept for compatibility — not part of the paper.

---

## File layout

```
elizaos_vending_bench/
├── __init__.py              # Public exports (no MockLLMProvider)
├── _testing.py              # MockLLMProvider lives here
├── agent.py                 # VendingAgent + LLMProvider protocol
├── cli.py                   # CLI entrypoint
├── environment.py           # VendingEnvironment + EconomicModel
├── evaluator.py             # CoherenceEvaluator + failure-mode detectors
├── reporting.py             # Markdown report generator
├── runner.py                # Multi-run harness + JSON/markdown output
├── sub_agents.py            # EmailSubAgent, ResearchSubAgent
├── tool_simulators.py       # EmailSimulator, WebSimulator, Notepad
├── types.py                 # All dataclasses + enums
├── providers/               # Real LLM provider bridges (openai, anthropic)
└── tests/                   # Pytest suite (103 tests)
```

---

## References

- Vending-Bench paper: https://arxiv.org/abs/2502.15840
- Leaderboard: https://andonlabs.com/evals/vending-bench
- Andon Labs GitHub: https://github.com/AndonLabs (no public vending-bench
  evaluator as of May 2026)
