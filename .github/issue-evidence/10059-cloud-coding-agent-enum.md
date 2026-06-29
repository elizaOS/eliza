# #10059 — Cloud: accept `elizaos` as a coding-container agent

## Scope of this change

The app-side eliza-code work is merged (#10030/#10056) and the orchestrator
already resolves `elizaos` → `eliza-code-acp` (`plugins/plugin-agent-orchestrator/
src/services/acp-service.ts`). One concrete cloud-side **code** gap from the
issue's review was still open:

> `/api/v1/coding-containers` only accepts `claude | codex | opencode`; `elizaos`
> is not a valid cloud coding agent yet.

This change closes that gap. It is the safe, additive, in-repo prerequisite that
must land before any cloud deploy can route coding to eliza-code.

## Change

`packages/shared/src/contracts/cloud-coding-containers.ts`:

```ts
export const CloudCodingAgentSchema = z.enum([
  "claude", "codex", "opencode", "elizaos",
]);
```

`CloudCodingAgent` is inferred from this schema, and it drives the
`RequestCodingAgentContainerRequest.agent` / `preferredAgent` validation used by
`packages/cloud/api/v1/coding-containers/route.ts`. The `agent` value only flows
into the runner env (`ELIZA_CODING_AGENT` / `ELIZA_CLOUD_CODING_AGENT`) and the
container name/description — **nothing selects or installs a CLI from it** — so
widening the enum is purely additive and safe.

The **default stays `claude`** on purpose: the runner image must actually ship the
`eliza-code-acp` bin before `elizaos` can become the default, otherwise a
defaulted request would target an agent the image can't run. Flipping the default
is a deploy-time decision, not a contract change.

## Verification

`packages/cloud/shared/src/lib/services/coding-containers.test.ts`:
- `accepts elizaos (the eliza-code cloud coding agent, #10059)` → parses `agent:"elizaos"`
  and asserts the create payload injects `ELIZA_CODING_AGENT=elizaos` /
  `ELIZA_CLOUD_CODING_AGENT=elizaos`.
- `rejects an unknown coding agent` → guards the enum boundary.
- Existing `defaults a missing agent to claude` / `still honors an explicit agent`
  unchanged.

```
$ bun test packages/cloud/shared/src/lib/services/coding-containers.test.ts
 22 pass  0 fail
```

## Remaining work — deploy-gated (cloud team / creds), documented not done

Verified from this build host (no `wrangler`, gh token lacks `write:packages`,
prod hosts unreachable). These are NOT code-doable safely here and were left out
deliberately rather than shipped as stubs:

1. **Publish `@elizaos/example-code`** to npm (ships `eliza-code-acp`). Packaging
   metadata is already in-repo (#10086: bin + files allowlist + shebang +
   `lerna.json`); only the `npm publish` (creds) remains. `@elizaos/plugin-coding-tools`
   needs an `alpha` dist-tag (today only `latest`/`beta`).
2. **Install eliza-code in the coding-runner image** —
   `packages/cloud/services/coding-remote-runner/Dockerfile` installs codex/
   claude-code/opencode globally; add an `eliza-code` install once (1) publishes.
   (Left out now: an install line for an unpublished package would red the image build.)
3. **Architecture decision (cloud team):** does the managed *chat* agent host the
   orchestrator (un-strip it from the `lean-chat` set / `Dockerfile.ci`'s `rm -rf`),
   or does cloud coding flow exclusively through the coding-container runner above?
   The lean-chat policy deliberately strips the orchestrator for cold-start (#8434),
   so the managed-env `ELIZA_ACP_DEFAULT_AGENT=elizaos` default cannot work
   standalone — it needs this decision first. Not implemented here to avoid a
   speculative product change.
