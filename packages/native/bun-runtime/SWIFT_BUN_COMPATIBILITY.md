# SwiftBun Compatibility Lane

## Decision

Keep the Eliza mobile runtime TypeScript-owned and add SwiftBun only as an
optional bridge candidate.

The native side may provide JavaScriptCore hosting, filesystem adapters, stream
plumbing, and Capacitor IPC. It must not own agent semantics, plugin routing,
model selection, onboarding, generated UI, or sandbox routing. Those stay in the
TypeScript agent bundle and the existing elizaOS plugin/runtime layers.

## Backend Lanes

| Backend | Role | Status | Production local iOS |
| --- | --- | --- | --- |
| `full-bun-engine` | `ElizaBunEngine.xcframework` running the TypeScript agent bundle through the C ABI in the iOS app process | Primary target | Yes |
| `swift-bun-jscore` | SwiftBun-compatible JavaScriptCore bridge running an Eliza-compatible route kernel | Candidate | No |
| `ittp-jscontext` | Existing JSContext ITTP compatibility fallback | Development/compatibility | No |

The backend policy is codified in
`packages/app-core/src/platform/ios-runtime-backends.ts`.

## Why This Exists

The owner constraint is that the product remains TypeScript. SwiftBun is useful
only if it helps the iOS host execute or route TypeScript without creating a
separate Swift agent runtime.

This gives us both paths:

- Continue the full Bun framework path for the real local iOS runtime.
- Spike SwiftBun as a thinner JavaScriptCore compatibility bridge when full Bun
  is unavailable.

## SwiftBun Acceptance Gates

A SwiftBun-backed lane must prove all of these before becoming selectable
outside explicit compatibility mode:

- Implements the existing Capacitor `ElizaBunRuntime` plugin surface.
- Routes `call({ method: "http_request" })` through the same local-agent API
  contract used by the WebView.
- Routes `sendMessage` through the TypeScript agent or an explicitly documented
  route-kernel equivalent.
- Keeps native code bridge-only.
- Does not introduce downloaded executable code, JIT entitlement requirements,
  process spawning, shell execution, Bun FFI, native extension loading, or TCP
  backend assumptions for iOS local runtime.
- Reports unsupported local inference, PGlite, filesystem, and llama bridge
  capabilities as structured capability results instead of pretending they are
  available.
- Passes simulator route smoke before any device/sideload validation.

## What It Does Not Replace

SwiftBun does not replace:

- `ElizaBunEngine.xcframework`
- `packages/agent/dist-mobile-ios/agent-bundle.js`
- `ios-bridge --stdio`
- the Capacitor `ElizaBunRuntime` public contract
- cloud/home/sandbox Satellites for coding agents
- the TypeScript plugin system

## Mobile Coding Agents

The native iOS app can run the Eliza agent on-device. That does not make iOS a
coding sandbox. Codex, Claude Code, OpenCode, PTY sessions, host shell tooling,
`xcodebuild`, and app compilation route to a remote sandbox, Eliza Cloud, or a
trusted home machine worker. The local iOS runtime is for foreground agent
interaction, local model/voice where supported, native device capability
bridges, and mobile-safe generated UI.

## Next Implementation Step

Do not add a SwiftBun dependency until the compatibility spike proves the route
contract above. The first spike should live behind an explicit build flag and
return a visible backend status through the existing local-agent capabilities
endpoint.
