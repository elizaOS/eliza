# HyperliquidBench Coverage Tasks

Each `.jsonl` file contains one complete runner plan per line. Reference a
specific scenario as `dataset/tasks/<file>.jsonl:<line>` when calling
`hl-runner` or `scripts/run_cov.sh`.

- `hl_perp_basic_01.jsonl` places paired ETH ALO/GTC orders and cancels the
  last routed order.
- `hl_cancel_sweep_01.jsonl` rests an ETH order, waits briefly, then cancels
  all ETH orders.
- `hl_risk_and_account_01.jsonl` transfers USDC to perps, sets isolated ETH
  leverage, then submits an IOC reduce-only order.
