# Eliza GenUI

Eliza GenUI is an elizaOS-owned generated UI layer for declarative, trusted, agent-created surfaces. It targets an A2UI v0.9-compatible shape while keeping rendering, action routing, runtime calls, and permissions inside Eliza-owned modules.

## Dependency Decision

Do not add Google A2UI as a production dependency yet.

A2UI is the right reference shape because it uses a trusted component catalog, declarative JSON, and incremental updates. The upstream project is still a public-preview format with renderer adapters in active development, so this package implements the minimal compatible subset locally first.

This keeps the module interface small:

```text
Eliza GenUI spec
  -> validator
  -> packages/ui renderer
  -> controlled action handler
```

No generated UI can import a component, execute code, call a Satellite, or reach Electrobun main-process internals directly.

## Existing elizaOS A2UI Seams

The repo already has two A2UI-adjacent seams:

- chat messages can carry `ui-spec` content blocks, with plain text as fallback
- canvas/dynamic-view hosts can receive A2UI pushes and reset events

Eliza GenUI sits between those seams and `packages/ui`: it validates a trusted spec, renders the supported catalog, and delegates every action to injected handlers. It does not replace the canvas bridge or the chat content-block transport.

## Supported Shape

The first supported shape follows the simpler A2UI v0.9 form:

```json
{
  "version": "0.1",
  "a2uiVersion": "0.9",
  "root": "card",
  "components": [
    { "id": "card", "component": "Card", "child": "content" },
    { "id": "content", "component": "Text", "text": "Hello" }
  ]
}
```

## Catalog

Primitive components:

```text
Row
Column
List
Text
Image
Icon
Divider
Button
TextField
CheckBox
Slider
DateTimeInput
ChoicePicker
Card
Modal
Tabs
```

Eliza-specific placeholders:

```text
ProviderSetupCard
ModelPicker
ConnectorSetupCard
PermissionRequest
StarterPackStatus
LaunchDiagnosticsCard
TraceTimeline
VoiceLatencyTimeline
ToolCallTimeline
GitDiffViewer
TerminalTranscript
FileSearchResults
ModelDownloadStatus
```

The domain components start as render-safe placeholders. They should deepen into reusable `packages/ui` rendering modules as trace, voice, model, terminal, and Git views mature.

## Actions

Actions must use this format:

```json
{
  "event": {
    "name": "model.download.start",
    "payload": { "modelId": "eliza-1-2b" }
  }
}
```

Allowed action families:

```text
setup.*
model.*
provider.*
connector.*
runtime.*
capability.*
dynamicView.*
trace.*
voice.*
```

Handlers are injected by the host view. A generated spec never chooses arbitrary methods and never calls Satellites directly.

## Streaming

`applyElizaGenUiPatch` supports JSON Pointer-like `add`, `replace`, and `remove` operations, then validates the whole spec after each patch batch. Dynamic views can carry these patches through `dynamicViewPush`; this package only validates and renders the resulting state.

## Dynamic View Use

The intended dynamic view flow is:

```text
dynamicViewOpen("eliza.genui")
  -> initial ElizaGenUiSpec
dynamicViewPush("genui.patch")
  -> applyElizaGenUiPatch
  -> ElizaGenUiRenderer
```

The demo starter setup spec lives in `starter-pack-demo.ts`. It is not a production onboarding wizard.
