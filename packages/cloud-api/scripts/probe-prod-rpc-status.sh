#!/usr/bin/env bash
#
# Probe the deployed /api/admin/rpc-status endpoint and print a per-chain
# pass/fail summary. Requires an admin session.
#
# Usage:
#   # With a session cookie (copy from browser devtools → Network → Cookie header):
#   COOKIE='<value of Cookie header>' ./probe-prod-rpc-status.sh
#
#   # Or with an API key:
#   API_KEY='<elizaos_apikey_...>' ./probe-prod-rpc-status.sh
#
#   # Override the host if needed:
#   HOST=https://api.elizacloud.ai ./probe-prod-rpc-status.sh

set -euo pipefail

HOST="${HOST:-https://api.elizacloud.ai}"
URL="${HOST}/api/admin/rpc-status"

if [[ -n "${API_KEY:-}" ]]; then
  AUTH_FLAG=(-H "X-API-Key: ${API_KEY}")
elif [[ -n "${COOKIE:-}" ]]; then
  AUTH_FLAG=(-H "Cookie: ${COOKIE}")
else
  echo "error: set COOKIE or API_KEY env var" >&2
  exit 2
fi

echo "→ GET ${URL}"
RESP=$(curl -sS --fail-with-body -w "\n__HTTP__%{http_code}" "${URL}" "${AUTH_FLAG[@]}" || true)
HTTP_CODE=$(echo "${RESP}" | sed -n 's/.*__HTTP__\([0-9]*\)$/\1/p')
BODY=$(echo "${RESP}" | sed 's/__HTTP__[0-9]*$//')

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "FAIL: HTTP ${HTTP_CODE}"
  echo "${BODY}"
  exit 1
fi

echo "${BODY}" | jq -r '
  .data as $d
  | (
      "treasury hot wallet (EVM): \($d.hotWalletAddress // "—")",
      "solana RPC: \($d.solana.rpcUrl) (\(if $d.solana.configured then "key configured" else "no key" end))",
      "",
      ( $d.evm[] |
        "[\(.network)] \(if .reachable then "OK " else "FAIL" end)  chainId=\(.chainId)  block=\(.latestBlock // "—")  latency=\(.latencyMs // "—")ms  source=\(.rpcSource)  balance=\(.hotWalletBalance // "—") ELIZA\(if .error then "  error=\(.error)" else "" end)"
      ),
      "",
      "all reachable: \($d.allReachable)"
    )
'

# Final exit code: 0 if all chains reachable, 1 otherwise.
ALL=$(echo "${BODY}" | jq -r '.data.allReachable')
if [[ "${ALL}" != "true" ]]; then
  exit 1
fi
