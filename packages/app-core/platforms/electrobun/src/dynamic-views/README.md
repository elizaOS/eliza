# Dynamic Views

Dynamic views are temporary, contextual views opened by trusted agent, plugin, Remote, or developer code. They sit on top of the existing Electrobun canvas/A2UI window primitives and do not replace the production app UI.

The platform contract is:

```text
agent/plugin/runtime event
  -> register or open a DynamicViewManifest
  -> canvas/A2UI hosts the view session
  -> the view calls Remotes through eliza.runtime with carrotInvokeWorker
  -> the view tails worker events with carrotTailWorkerEvents
  -> the view is closed when the task no longer needs it
```

`eliza.surface` remains a dev/admin harness. Dynamic views are the path for contextual agent-created UI, trace views, and future capability output views without adding fixed panels.

## Host APIs

Typed renderer RPC:

- `dynamicViewRegister`
- `dynamicViewUnregister`
- `dynamicViewList`
- `dynamicViewOpen`
- `dynamicViewClose`
- `dynamicViewPush`
- `dynamicViewSessions`

Trusted workers can use host requests:

- `dynamic-view-register`
- `dynamic-view-unregister`
- `dynamic-view-list`
- `dynamic-view-open`
- `dynamic-view-close`
- `dynamic-view-push`
- `dynamic-view-sessions`

Worker host requests currently require `host:manage-carrots`. A narrower view-management permission should replace that once the manifest permission model adds it.

## Demo

`agent.run.trace.demo` is a developer-only proof of the dynamic view path. It opens a floating canvas view, receives A2UI pushed events, calls `eliza.runtime` through `carrotInvokeWorker`, and tails `eliza.runtime` events through `carrotTailWorkerEvents`.
