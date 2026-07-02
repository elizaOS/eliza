# Issue #11637: MCP Proxy Post-Debit Refunds

PR: #11652
Date: 2026-07-02

## Scope

The MCP metered proxy debits the caller before forwarding to the MCP endpoint.
This fix refunds that upfront debit on every covered post-debit failure branch:

- unsafe external endpoint
- missing container load balancer
- endpoint misconfiguration
- invalid JSON request body
- unreachable upstream / fetch failure
- non-ok upstream response

Successful upstream responses still keep the debit and record usage without a
second deduction.

## Verification

```text
bun test packages/cloud/api/__tests__/mcp-proxy-refund.test.ts
=> 6 pass, 0 fail, 14 expect() calls
```

Expected coverage:

- 502 unreachable upstream refunds once.
- 400 unsafe endpoint refunds once.
- 503 container unavailable refunds once.
- 400 invalid JSON body refunds once.
- non-ok upstream response refunds once.
- successful upstream response does not refund.

Additional static checks:

```text
bunx @biomejs/biome check .github/issue-evidence/11637-mcp-proxy-refund.md packages/cloud/api/mcp/proxy/[mcpId]/route.ts packages/cloud/api/__tests__/mcp-proxy-refund.test.ts --files-ignore-unknown=true
=> clean

git diff --check origin/develop...HEAD
=> clean

bun run --cwd packages/cloud/api typecheck
=> passed
```

## N/A

- UI screenshots/video: N/A - backend route money-path behavior only.
- Live model trajectory: N/A - no model/prompt/action behavior changed.
- Migration evidence: N/A - no schema or migration changed.
