# Dead Code Audit

## Summary
- Knip version + command used: `knip 6.4.1` via `DATABASE_URL=postgres://user:pass@localhost:5432/db bunx knip@latest --production --no-progress`
- Total findings: 107
- Verified dead + removed: 6
- False positives / kept: 4
- Deferred: 97

## Removed
### 1. `packages/api/src/services/waifu-bridge.ts`
- Evidence: knip flagged it as an unused file, and repo-wide grep found no references to `WaifuBridge`, `WAIFU_CHAIN_ID`, `ProvisionAgentResult`, or the file path outside the file itself.
- Risk: low, internal API service file with no imports or route wiring.

### 2. `web/src/components/auth-wrapper.tsx`
- Evidence: knip flagged it as an unused file, and repo-wide grep found no imports of `AuthWrapper` or the file path.
- Risk: low, deprecated compatibility shim inside the app.

### 3. `web/src/components/dashboard-nav.tsx`
- Evidence: knip flagged it as an unused file, and the dashboard layout defines and uses its own local `DashboardNav` instead.
- Risk: low, duplicate component superseded by in-file implementation.

### 4. `web/src/components/wallet-provider.tsx`
- Evidence: knip flagged it as an unused file, and repo-wide grep found no imports of `WalletProvider` or the file path.
- Risk: low, deprecated no-op wrapper inside the app.

### 5. `web/src/lib/auth-api.ts`
- Evidence: knip flagged it as an unused file, and repo-wide grep found no imports of `signInWithPasskey`, `sendMagicLink`, `verifyMagicLink`, or the file path.
- Risk: low, superseded auth helper layer.

### 6. `web/src/lib/wagmi.ts`
- Evidence: knip flagged it as an unused file, and repo-wide grep found no imports of the exported config or the file path.
- Risk: low, unused wallet config leftover after auth/provider migration.

## Kept (knip false positives)
### A. `packages/api/src/embedded.ts`
- Why knip flagged: unused file
- Why actually used: launched by `scripts/start-local.ts` via `bun run packages/api/src/embedded.ts`

### B. `scripts/e2e-auth-test.ts`
- Why knip flagged: unused file
- Why actually used: CLI entrypoint from root `test:e2e:auth` script

### C. `scripts/e2e-integration-test.ts`
- Why knip flagged: unused file
- Why actually used: CLI entrypoint from root `test:e2e:integration` script

### D. `scripts/run-e2e-smoke.ts`
- Why knip flagged: unused file
- Why actually used: CLI entrypoint from root `test:e2e:smoke` script

## Deferred (ambiguous)
### Files and exports pending manual verification
- Remaining knip findings require targeted grep verification before removal.
- Intentionally deferred for now:
  - all dependency/devDependency findings
  - all `packages/sdk` and `packages/react` public-surface export findings
  - all test files, config files, generated files, and scripts
  - duplicate export warning in `packages/eliza-plugin/src/index.ts`, likely package-surface noise rather than removable dead code

## Files changed
- `QUALITY_AUDIT.md`
- deleted `packages/api/src/services/waifu-bridge.ts`
- deleted `web/src/components/auth-wrapper.tsx`
- deleted `web/src/components/dashboard-nav.tsx`
- deleted `web/src/components/wallet-provider.tsx`
- deleted `web/src/lib/auth-api.ts`
- deleted `web/src/lib/wagmi.ts`
