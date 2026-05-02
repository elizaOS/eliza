# Frontend + SDK Code Review

**Reviewed:** 2026-04-11
**Scope:** packages/sdk/src, packages/react/src, web/src
**Reviewer:** Sol (subagent)

---

## Critical (must fix)

- **[packages/react/src/components/StewardLogin.tsx:58-64]** **Rules of Hooks violation.** `useRef(false)` and `useEffect(...)` are called AFTER the early `if (!ctx) return (...)` statement. React requires all hooks to be called unconditionally on every render. If `ctx` is null, these hooks are skipped, and when `ctx` becomes non-null, React will crash with "Rendered more hooks than during the previous render." Move the `if (!ctx)` check below all hook declarations, or restructure the component.

- **[packages/react/src/components/TransactionHistory.tsx:27-29]** **Rules of Hooks violation.** `useTransactions()` hook is called on line 29 AFTER a conditional early return on line 27 (`if (!features.showTransactionHistory) return null`). If the feature flag changes at runtime, this will crash React. Move the feature-flag check below the hook call.

- **[web/src/components/providers.tsx:27]** **Missing required `agentId` prop.** `StewardProvider` requires `agentId` as a required prop (see `StewardProviderProps` in types.ts), but `Providers` passes no `agentId`. This means `useStewardContext().agentId` will be `undefined`, breaking all hooks that depend on it (`useWallet`, `useTransactions`, `usePolicies`, `useApprovals`, `useSpend`). The `as any` cast on line 27 hides this type error. The dashboard doesn't use the React package hooks directly (it uses the inline client), so this doesn't crash currently, but any consumer mounting `@stwd/react` components inside the dashboard would fail.

- **[web/src/lib/api.ts:20 + web/src/lib/steward-client.ts:112]** **API client config mismatch.** `api.ts:setAuthToken()` creates `new StewardClient({ authToken: token })`, and the inline `StewardClient` in `steward-client.ts` reads `config.authToken`. However, the published `@stwd/sdk` `StewardClient` expects `bearerToken`, not `authToken`. If the dashboard ever migrates to the published SDK client, all authenticated requests will silently send no auth header. This is a ticking time bomb.

- **[web/src/components/auth-provider.tsx:44]** **`address` is always undefined.** The compatibility shim reads `(user as unknown as Record<string, unknown>)?.address`, but `StewardUser` only has `{ id, email, walletAddress? }`. The `address` property doesn't exist on the user object. This means `SettingsPage` will never show the wallet address, and any code checking `address` for SIWE-authenticated users will silently fail.

## High (should fix soon)

- **[packages/react/src/components/StewardOAuthCallback.tsx:55-64]** **Token stored directly in localStorage, bypasses auth context.** When the server returns a token in the URL (flow 1), the component writes directly to `localStorage` (`steward_session_token`) instead of going through `StewardAuth.storeAndReturn()`. This means: (1) the auth context's `onSessionChange` listeners never fire, (2) `useAuth().isAuthenticated` stays false until page reload, (3) the session object is never hydrated. Users will see "Signed in successfully" but the app won't actually recognize them as authenticated until a full page refresh.

- **[packages/react/src/hooks/useTransactions.ts:28-37]** **Raw fetch without auth headers.** The hook accesses the private `baseUrl` via `(client as unknown as Record<string, string>).baseUrl` and makes a raw `fetch()` call with no `Authorization` header or `X-Steward-Key`. All authenticated endpoints will return 401. Same issue in `useApprovals.ts:20-24` and `useSpend.ts:18-22`.

- **[packages/react/src/hooks/useApprovals.ts:20]** **Wrong API endpoint.** The hook fetches `/agents/${agentId}/approvals?status=pending` but the SDK client's `listApprovals()` uses `/approvals` (tenant-level, not agent-scoped). The approve endpoint uses `/agents/${agentId}/approvals/${txId}/approve` but the SDK uses `/approvals/${txId}/approve`. These endpoints may not exist on the server.

- **[web/src/app/dashboard/approvals/page.tsx:35-36]** **Auth headers always empty.** `TENANT_ID` and `API_KEY` come from `useAuth().tenant`, which in the compatibility shim sets `apiKey: undefined`. So all raw `fetch` calls on this page send empty `X-Steward-Tenant` and `X-Steward-Key` headers. The JWT from the session is never attached. Approvals page likely returns 401 for authenticated users.

- **[web/src/app/dashboard/settings/page.tsx:10]** **Settings page broken for non-SIWE users.** `address` is always undefined (see Critical #5). The entire "Account" section (`address && (...)` on line 41) will never render for email/passkey authenticated users, even though they may have a wallet address via `walletAddress`.

- **[packages/react/src/provider.tsx:136-142]** **Tenant config fetch has no auth and wrong endpoint.** The provider fetches `/tenants/config` with no auth headers, but the SDK's `getTenantConfig()` requires a tenant ID in the path: `/tenants/${tenantId}/config`. This will always 404 or return a generic response.

- **[web/src/lib/steward-client.ts:135-140]** **`getHistory` returns wrong type.** The inline client's `getHistory` returns `TxRecord[]`, but the published SDK's `getHistory` returns `StewardHistoryEntry[]` which is `{ timestamp: number; value: string }[]` (no `id`, `status`, `toAddress`, etc.). Dashboard code accesses `tx.status`, `tx.toAddress`, `tx.txHash`, `tx.request.to`, etc. on history entries, which will be undefined if the API actually returns the SDK-shaped response.

## Medium (tech debt)

- **[packages/react/src/provider.tsx:102-112]** **`signInWithOAuth` uses fragile dynamic dispatch.** Instead of calling `authInstance.signInWithOAuth(...)` directly, it casts to `Record<string, unknown>` and checks `typeof authAny.signInWithOAuth`. This was presumably a compatibility check, but `StewardAuth` always has `signInWithOAuth` since it's defined in auth.ts. Remove the cast and call directly.

- **[packages/react/src/provider.tsx:120-135]** **Provider discovery uses same fragile cast pattern.** `getProviders` is a public method on `StewardAuth`, no need for `as unknown as Record<string, unknown>` and runtime type checking. Same for `listTenants` (line 158), `switchTenant` (line 175), `joinTenant` (line 190), `leaveTenant` (line 204).

- **[packages/react/src/provider.tsx:219]** **Accessing private `baseUrl` from client.** `(client as unknown as { baseUrl: string }).baseUrl` breaks encapsulation. The StewardClient should expose `baseUrl` as a public getter, or the tenant config fetch should go through the client.

- **[packages/sdk/src/client.ts:286]** **`undefined as TSuccess` unsafe cast.** When the API returns no body (`typeof payload.data === "undefined"`), the method returns `undefined as TSuccess`. If `TSuccess` is a non-nullable type (e.g., `AgentIdentity`), the caller gets `undefined` where it expects an object. This will cause null dereference at call sites. Consider returning an error instead.

- **[packages/sdk/src/auth.ts:73-74]** **Double session parsing on `getToken()`.** `getToken()` calls `getSession()` (which parses the JWT), then calls `isNearExpiry()` which calls `getSession()` again (parses JWT again). For hot paths, this doubles the work. Cache the session or pass it through.

- **[web/src/app/dashboard/page.tsx:33-43]** **N+1 query pattern.** Dashboard fetches `listAgents()` then loops through each agent to call `getHistory(agent.id)`. For 20 agents, this makes 21 API calls sequentially. Should use a batch/aggregate endpoint (like `getAgentDashboard`) or at least `Promise.all`.

- **[web/src/app/dashboard/transactions/page.tsx:23-36]** **Same N+1 pattern.** Fetches all agents then loops to get history for each one. Same issue as dashboard overview.

- **[web/src/lib/steward-client.ts]** **Entire file is a duplicate of @stwd/sdk.** This inline client diverges from the published SDK in type shapes, method signatures, and API endpoints. Should be replaced with `@stwd/sdk` to avoid drift. Currently ~350 lines of duplicated/divergent code.

- **[packages/react/src/components/WalletOverview.tsx:35]** **Mutation of const filter result.** `displayAddresses` is declared with `const` and populated via `.filter()`, then `.push()` is called on line 41. While JavaScript allows this (const prevents reassignment, not mutation), it's semantically confusing. Use `let` or restructure.

- **[packages/react/src/types.ts vs packages/sdk/src/types.ts]** **Duplicate type definitions that drift.** `ApprovalQueueEntry` in react/types.ts has `to: string` and `value: string` fields, while sdk/types.ts has `toAddress?: string` and `value?: string` with `?` optional markers. `AgentDashboardResponse` in react has `solana?` balance field; sdk version doesn't. These will cause silent type mismatches.

- **[web/src/app/dashboard/tenants/page.tsx:49]** **Tenant switch uses different mechanism than auth context.** The page calls `steward.switchTenant()` which POSTs to `/user/me/tenants/switch` (inline client), but the `@stwd/react` provider's `switchTenant` calls `auth.switchTenant()` which POSTs to `/auth/refresh` with a new tenantId. These are likely different server endpoints with different behaviors. Active tenant state is stored in `localStorage` separately from the auth session, causing potential desync.

## Low (nice to have)

- **[packages/sdk/src/auth.ts:427]** **`base64urlEncode` uses `btoa(String.fromCharCode(...bytes))`.** For large byte arrays, the spread operator could hit the call stack limit. Not an issue for 32-byte code verifiers, but the function is general-purpose.

- **[packages/react/src/components/StewardUserButton.tsx:21-27]** **`simpleHash` for Gravatar is not MD5.** Gravatar requires MD5 hashes. The custom hash will never match a real Gravatar, so all users will get the `identicon` default. Either use a proper MD5 library or just always show initials.

- **[packages/react/src/utils/format.ts:14-15]** **`formatWei` loses precision for large values.** `BigInt(wei) / BigInt(10**18)` uses integer division, losing the fractional part. The fraction is recovered via modulo, but `Number(BigInt(wei))` on line 14 will lose precision for values > 2^53.  The function handles this correctly with BigInt math, but `Number(BigInt(wei))` in the SpendingLimitEditor's `toEth()` (PolicyControls.tsx:170) will silently produce wrong values for large wei amounts.

- **[packages/react/src/components/PolicyControls.tsx:176]** **`toWei` uses `Math.floor(parseFloat(eth) * 1e18)`.** Floating-point multiplication of ETH values will produce rounding errors. `0.1 * 1e18 = 100000000000000000` works, but `0.3 * 1e18 = 299999999999999940`. Should use a decimal library or string-based conversion.

- **[web/src/components/auth-provider.tsx:56]** **`signIn` and `completeEmailAuth` are no-ops.** These shim methods do nothing. Any code calling them will silently succeed without actually doing anything. Should either be removed from the interface or throw "deprecated" errors.

- **[web/src/components/auth-wrapper.tsx]** **Dead code.** Deprecated no-op component. Should be removed once confirmed no imports remain.

- **[packages/react/src/styles.css]** **No dark/light mode toggle.** `colorScheme` is in the theme type but CSS doesn't implement system preference detection or theme switching. All styles assume dark mode.

- **[web/src/app/dashboard/agents/[id]/page.tsx:31-37]** **`ALL_POLICY_TYPES` has 6 entries but comment says "All 5".** The array includes `allowed-chains` as a 6th type. The UI text says "All 5 policy types" which is wrong.

- **[packages/react/src/components/StewardEmailCallback.tsx:28-29]** **Missing deps in useEffect.** The empty deps array `[]` with `eslint-disable` means `verifyEmailCallback` and `isAuthenticated` are captured at mount time. If the auth context changes (e.g., token refresh), the stale closure could cause issues. The `attemptedRef` guard mitigates most of this, but it's still a code smell.

- **[packages/react/src/hooks/useWallet.ts:23]** **`getAddresses` error swallowed silently.** The catch returns `{ addresses: [] }` which makes it look like the agent has no addresses, when the endpoint might just be down. Should distinguish "no addresses" from "fetch failed."

## API Contract Mismatches

- **[Dashboard `StewardClient.authToken` vs SDK `StewardClient.bearerToken`]** The inline client in `web/src/lib/steward-client.ts` uses `config.authToken` for JWT auth. The published `@stwd/sdk` client uses `config.bearerToken`. Migrating to the SDK client will break auth silently.

- **[Dashboard `getHistory()` returns `TxRecord[]` vs SDK returns `StewardHistoryEntry[]`]** The inline client returns full transaction records. The SDK returns `{ timestamp: number; value: string }[]`. Dashboard code accesses `.status`, `.toAddress`, `.txHash`, `.request.to`, `.request.chainId`, `.policyResults` on history entries, none of which exist on `StewardHistoryEntry`.

- **[Dashboard `TxRecord.toAddress` vs SDK `TxRecord.request.to`]** Inline client has `toAddress: string` as a top-level field. SDK has `request: SignRequest` where `to` is nested. Dashboard code accesses both patterns with fallbacks (`tx.request?.to || tx.toAddress`), which works but indicates the API response shape is ambiguous.

- **[Dashboard `TxRecord.createdAt: string` vs SDK `TxRecord.createdAt: Date`]** The inline client types `createdAt` as `string`. The SDK types it as `Date`. When `parseAgentIdentity` runs `new Date(agent.createdAt)`, it converts strings to Dates, but `TxRecord` has no such parse step in the SDK. Dashboard code passes `tx.createdAt` to `formatDate()` which handles both, but direct `Date` method calls would fail on strings.

- **[Dashboard `AgentIdentity` missing `walletAddresses`]** The inline client's `AgentIdentity` doesn't have `walletAddresses?: { evm?: string; solana?: string }` which the SDK added for multi-chain support. Dashboard agent detail page only shows `walletAddress` (single EVM address).

- **[React `useApprovals` endpoint vs SDK `listApprovals` endpoint]** React hook fetches `/agents/${agentId}/approvals?status=pending`. SDK's `listApprovals()` calls `/approvals` (tenant-scoped, not agent-scoped). Hook's approve/reject endpoints also differ: `/agents/${agentId}/approvals/${txId}/approve` vs SDK's `/approvals/${txId}/approve`.

- **[React `TenantControlPlaneConfig.features` vs SDK `TenantControlPlaneConfig.featureFlags`]** React types have `features: TenantFeatureFlags` with specific boolean fields. SDK types have `featureFlags?: Record<string, boolean>`. Provider code reads `tenantConfig?.features` but the server likely sends `featureFlags`.

- **[Dashboard approvals page uses old pending endpoint]** `ApprovalsPage` fetches `/vault/${agent.id}/pending` which is the v1 pending approval endpoint. The SDK uses `/approvals` with query params. The dashboard also uses `/vault/${agentId}/approve/${txId}` and `/vault/${agentId}/reject/${txId}` while the SDK uses `/approvals/${txId}/approve` and `/approvals/${txId}/deny` (note: "deny" vs "reject").

- **[Dashboard `AuditEntry.result` mapping is buggy]** In `steward-client.ts:221`, the audit log mapping has a duplicate condition: `e.status === "error"` maps to both `"deny"` (first branch) and `"error"` (unreachable second branch). The ternary `(e.status === "rejected" || e.status === "error" || e.status === "denied") ? "deny" : e.status === "error" ? "error" : "allow"` will never reach the `"error"` case because `"error"` is already caught in the first condition.

---

## Summary

**Blockers (3):** Two Rules of Hooks violations will crash React at runtime. Missing `agentId` prop breaks all React package hooks.

**Auth flow issues (4):** OAuth callback bypasses auth context, raw fetches with no auth headers, compatibility shim's `address` always undefined, approvals page sends empty auth.

**SDK/Dashboard drift (5):** The inline `StewardClient` in the dashboard has diverged from the published `@stwd/sdk` in type shapes, property names, and API endpoints. This is the root cause of most contract mismatches and will make migration painful.

**Recommended priority:**
1. Fix the two hooks violations (5 min each)
2. Kill the inline `StewardClient`, import `@stwd/sdk` directly
3. Fix OAuth callback to use auth context properly
4. Add auth headers to React hooks' raw fetch calls
5. Reconcile API endpoint paths (approvals, pending, history)
