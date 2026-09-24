# Dynamic Views

Dynamic views are temporary, contextual views opened by trusted agent, plugin, or developer code. They sit on top of the existing Electrobun canvas/A2UI window primitives and do not replace the production app UI.

The platform contract is:

```text
agent/plugin/runtime event
  -> register or open a DynamicViewManifest
  -> canvas/A2UI hosts the view session
  -> the view is closed when the task no longer needs it
```

Dynamic views are the path for contextual agent-created UI, trace views, and future capability output views without adding fixed panels.

## Host APIs

Typed renderer RPC:

- `dynamicViewRegister`
- `dynamicViewUnregister`
- `dynamicViewList`
- `dynamicViewOpen`
- `dynamicViewClose`
- `dynamicViewPush`
- `dynamicViewSessions`

## Demo

`agent.run.trace.demo` is a developer-only proof of the dynamic view path. It opens a floating canvas view and receives A2UI pushed events.
