# #13417 Cloud-Shared Lib Helper Fallback Evidence

## Scope

Targeted first slice for `packages/cloud/shared/src/lib/utils/json-parsing.ts` and its known cloud service callers. This does not claim to close the full #13417 inventory; it removes one helper-level success-shaped fallback and documents the remaining intentional diagnostic fallback.

## Fallback Census

Before command:

```bash
rg -l --glob '!**/*.test.ts' --glob '!**/*.test.tsx' --glob '!**/__tests__/**' --glob '*.ts' --glob '*.tsx' "catch\s*\(|\.catch\s*\(|\?\?\s*(0|\[\]|\{\}|''|\"\")|\|\|\s*(0|\[\]|\{\}|''|\"\")|console\." packages/cloud/shared/src/lib | sed 's#^packages/cloud/shared/src/lib/##' | cut -d/ -f1 | sort | uniq -c | sort -nr | head -30
```

Before top buckets:

```text
 320 services
  47 eliza
  18 utils
  16 providers
  11 cache
   8 auth
   5 api
   4 mcp
   4 debug
```

After top buckets:

```text
 320 services
  47 eliza
  18 utils
  16 providers
  11 cache
   8 auth
   5 api
   4 mcp
   4 debug
```

The bucket count is unchanged because this is a broad package inventory and `utils` still has other candidates. The targeted helper changed from an unannotated `safeJsonParse()` that returned `{}` for empty or malformed response bodies to:

- `parseJsonResponse()` for success payloads, which throws on empty/malformed JSON.
- `parseJsonErrorBody()` for provider error payload diagnostics, annotated `error-policy:J3`.

## Changed Fallback Verdicts

| Path | Verdict |
| --- | --- |
| `packages/cloud/shared/src/lib/utils/json-parsing.ts` | Removed success-shaped `{}` fallback from response parsing. Kept one J3 diagnostic fallback for third-party error bodies where HTTP status remains the failure signal. |
| `packages/cloud/shared/src/lib/services/twitter-automation/oauth2-client.ts` | Twitter OAuth2 success token parsing now uses strict `parseJsonResponse()`; non-OK error body parsing uses `parseJsonErrorBody()` and still throws on HTTP status. |
| `packages/cloud/shared/src/lib/services/social-media/token-refresh.ts` | Meta/LinkedIn/TikTok non-OK error body parsing uses explicit diagnostic parser; callers still throw provider refresh errors. |
| `packages/cloud/shared/src/lib/services/social-media/providers/reddit.ts` | Reddit non-OK error body parsing uses explicit diagnostic parser; caller still throws provider API error. |

## Focused Test Output

```text
bun test packages/cloud/shared/src/lib/utils/json-parsing.test.ts
6 pass
0 fail
```

## Verification

```text
bunx @biomejs/biome check packages/cloud/shared/src/lib/utils/json-parsing.ts packages/cloud/shared/src/lib/utils/json-parsing.test.ts packages/cloud/shared/src/lib/services/twitter-automation/oauth2-client.ts packages/cloud/shared/src/lib/services/social-media/token-refresh.ts packages/cloud/shared/src/lib/services/social-media/providers/reddit.ts
Checked 5 files. No fixes applied.

bun run audit:error-policy-ratchet
[error-policy-ratchet] no new fallback-slop in touched files

bun run --cwd packages/cloud/shared typecheck 2>&1 | rg 'json-parsing|twitter-automation/oauth2-client|social-media/token-refresh|social-media/providers/reddit'
no touched-file typecheck diagnostics

git diff --check origin/develop...HEAD && git diff --check
passed
```

## Runtime Logs

N/A - service helper unit boundary only. The changed paths parse `Response` bodies and preserve existing thrown provider errors; no live provider credentials were used.

## UI Screenshots

N/A - no UI, CSS, route, or rendered component changed.

## Model Trajectories

N/A - no agent, prompt, action, provider model invocation, or trajectory path changed.

## Audio

N/A - no voice, ASR, TTS, or audio path changed.
