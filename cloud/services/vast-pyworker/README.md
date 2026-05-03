# vast-pyworker — Qwen3.6-35B-A3B-AWQ on Vast Serverless

PyWorker that fronts a vLLM server hosting `QuantTrio/Qwen3.6-35B-A3B-AWQ`
(INT4) on a single RTX 5090 worker. Deployed by Vast.ai Serverless via
`PYWORKER_REPO` on the template.

## How Vast deploys this

Vast templates pull this directory at cold start by setting:

- `PYWORKER_REPO` — git URL of this repo
- `PYWORKER_REF` — branch/tag/commit (use a pinned commit in production)

The template `on_start` script then runs:

```bash
pip install -r requirements.txt
vllm serve QuantTrio/Qwen3.6-35B-A3B-AWQ \
  --host 127.0.0.1 --port 8000 \
  --quantization awq --max-model-len 32768 \
  > /var/log/vllm.log 2>&1 &
python worker.py
```

`worker.py` watches `/var/log/vllm.log` for readiness, forwards
`/v1/chat/completions` and `/v1/completions`, and reports per-request
workload back to the Vast Serverless Engine so it can scale the endpoint.

## Endpoint scaling

Vast manages the queue, load balancer, and autoscaler. Configure the
endpoint via `cloud/scripts/vast/provision-endpoint.ts`:

- `min_workers = 1`, `inactivity_timeout = -1` → always one warm worker
- `max_workers = 8`
- `target_util = 0.9`
- `search_params`: `gpu_name=RTX_5090`, `reliability ≥ 0.9`, verified, ≥ 23 GB VRAM, ≥ 16 GB disk

## Routing from eliza/cloud

The cloud Worker routes `vast/qwen3.6-35b-a3b-awq` requests through
`VastProvider` (`packages/lib/providers/vast.ts`), which posts to
`${VAST_BASE_URL}/v1/chat/completions` with `Authorization: Bearer
${VAST_API_KEY}`. Both secrets are wrangler-managed and listed in
`apps/api/wrangler.toml`.
