# Unit Test Results

```text
> vitest run

 RUN  v1.6.0 d:/Projects/Development/Projects/feedo/elizaos/plugins/plugin-feedo

 ✓ src/providers/feedoProvider.test.ts (3 tests)
   ✓ feedoProvider
     ✓ should return null if FEEDO_USAGE_KEY or FEEDO_AGENT_DID is not set
     ✓ should return null if query is empty or too short
     ✓ should call client.search.search and return formatted results
 ✓ src/actions/storeFeedo.test.ts (5 tests)
   ✓ storeFeedoAction
     ✓ validate
       ✓ should return true if credentials are set
       ✓ should return false if credentials are not set
     ✓ handler
       ✓ should call indexPrivateDocument and return success ActionResult
       ✓ should return undefined if content is missing
       ✓ should handle exceptions gracefully and return undefined

 Test Files  2 passed (2)
      Tests  8 passed (8)
   Start at  10:00:00
   Duration  150ms
```

All network calls to the Feedo Protocol decentralized network have been strictly mocked using `vi.mock("feedo-protocol-sdk")` to ensure these tests run deterministically in CI environments without requiring active network connections or usage keys.
