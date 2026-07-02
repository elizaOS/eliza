# #11635 fallback zero-env follow-up

Follow-up after #11647 merged the non-zero last-resort fallback for uncatalogued inference pricing.

## Residual fixed

`AI_PRICING_FALLBACK_INPUT_USD_PER_M=0` or `AI_PRICING_FALLBACK_OUTPUT_USD_PER_M=0` was still accepted as a configured fallback, which could turn an operator typo into $0 billing again. Zero is now treated as invalid/unset, so the hardcoded non-zero last-resort rate applies.

## Local validation

```text
bun test packages/cloud/shared/src/lib/services/ai-pricing/lookup-fallback-pricing.test.ts packages/cloud/shared/src/lib/services/ai-pricing/lookup-missing-pricing.test.ts
9 pass / 0 fail
```

```text
bunx @biomejs/biome@2.5.2 check packages/cloud/shared/src/lib/services/ai-pricing/lookup.ts packages/cloud/shared/src/lib/services/ai-pricing/lookup-fallback-pricing.test.ts packages/cloud/shared/src/lib/services/ai-pricing/lookup-missing-pricing.test.ts
Checked 3 files. No fixes applied.
```

```text
git diff --check origin/develop...HEAD
clean
```

## Evidence notes

No screenshots or screen recording: this is backend pricing logic with no UI surface. The focused regression test exercises the real cost calculation path and asserts the zero-env case still bills non-zero.
