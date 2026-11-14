# Public package contracts

The compatibility baseline is `@elizaos/core` 2.0.6 at commit `72fed7e4069ecd35d61d886ab6eec5c02c137517`. [The complete source and export inventory](./baseline/core-public-surface.json) records every tracked core file, hash, entrypoint, exported symbol and declaration. [The consumer inventory](./baseline/core-consumers.json) records imports and dependency ranges from that same commit. The replacement preserves exported names, required and optional fields, discriminants, Promise behavior and thrown errors wherever these inventories identify a consumer. Effect services and generated state remain behind that compatibility surface. A changed signature requires an explicit adaptation decision for its callers. [Behavior contracts and existing test vectors](./baseline/behavior-contracts.json) preserve source documentation, branch-conditioned results and errors, and fixture assertions. [Import closures](./baseline/import-graph.json) identify each entrypoint’s static runtime dependencies. [Source ownership](./baseline/source-contract-map.json) links every source/data file to its spec and records remaining cross-model refinement work.

Current entrypoints include the Node runtime root and renderer-safe `protocol`, `speech`, `logging`, `permissions`, `schema-types`, `view-interaction`, `task-events`, `task-widgets`, `read-memo`, `security/redact`, and the JSON catalog/restart exports. Browser-safe leaves retain their dependency closure. Module evaluation preserves existing side-effect behavior. The package ships ESM, declarations, JSON assets and source conditions under the existing npm name when implementation is approved.

The [consumer resolution notes](./baseline/compatibility-decisions.json)
distinguish a JSON default import from TypeScript export declarations, and
record the one private test import and cloud imports used only as types.
The restart asset retains its exported JSON shape and exit code. The
private test fixture needs an explicit adapter decision in the implementation
phase so it can exercise the same prepared request guard.

## Story: Consume the replacement through existing imports

As a plugin or host author, I want existing import names and structural contracts to remain usable when the runtime is replaced.

### A release accounts for every required public symbol and consumer

The release manifest covers the complete baseline export set and every observed consumer. Type compatibility is demonstrated by compiling consumer fixtures against packed declarations. Runtime compatibility is demonstrated through normal import and behavior entrypoints. This gate records those checks as evidence inputs, to be supplied during implementation.

```quint
pure def surfaceComplete(required: Set[str], exported: Set[str]): bool = required.subseteq(exported)
pure def releaseReady(required: Set[str], exported: Set[str], consumersCompile: bool, packageImports: bool, behaviorConforms: bool): bool = surfaceComplete(required, exported) and consumersCompile and packageImports and behaviorConforms
pure def lawReleaseIncludesEveryRequiredSymbol(required: Set[str], exported: Set[str], consumersCompile: bool, packageImports: bool, behaviorConforms: bool): bool = releaseReady(required, exported, consumersCompile, packageImports, behaviorConforms) implies required.subseteq(exported)
pure def lawIncompleteConsumersPreventRelease(required: Set[str], exported: Set[str], packageImports: bool, behaviorConforms: bool): bool = not(releaseReady(required, exported, false, packageImports, behaviorConforms))
```

### Required fields and discriminants survive a compatibility projection

Wire projection preserves every required field and its exact discriminant. Additional Effect environment requirements stay internal. Scalar helper semantics retain exact integer, Unicode, canonical JSON, MIME, locale and time behavior from the baseline declarations and tests.

```quint
pure def compatibleFields(required: Set[str], projected: Set[str], expectedTag: str, actualTag: str): bool = required.subseteq(projected) and expectedTag == actualTag
pure def lawCompatibilityRetainsDiscriminant(required: Set[str], projected: Set[str], expectedTag: str, actualTag: str): bool = compatibleFields(required, projected, expectedTag, actualTag) implies expectedTag == actualTag
```
