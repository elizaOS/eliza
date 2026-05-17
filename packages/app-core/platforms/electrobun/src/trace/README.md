# Trace

Trace is host-side observability for contextual agent-run views. It records trace sessions and ordered events for agent messages, model calls, tool calls, capability invokes, subagent activity, stream chunks, errors, and future voice stages.

Trace is not a dashboard replacement. It opens dynamic views when a run needs inspection, then streams events into that view through the existing dynamic view and A2UI path.

## Flow

```text
agent/runtime event
  -> trace session
  -> ordered trace events
  -> dynamic agent.run.trace view
  -> optional runtime/capability calls through eliza.runtime
```

## APIs

Renderer RPC:

- `traceSessionStart`
- `traceSessionComplete`
- `traceSessionCancel`
- `traceSessionError`
- `traceEventRecord`
- `traceSessionList`
- `traceSessionGet`
- `traceSessionSummary`
- `traceEventsTail`
- `traceEventsSearch`
- `traceViewOpen`

Trusted worker host requests:

- `trace-session-start`
- `trace-session-complete`
- `trace-session-cancel`
- `trace-session-error`
- `trace-event-record`
- `trace-session-list`
- `trace-session-get`
- `trace-session-summary`
- `trace-events-tail`
- `trace-events-search`
- `trace-view-open`

Worker access is gated through the existing trusted host permission boundary. A narrower trace-specific host permission can replace that once the manifest permission model supports it.

## Dynamic View

The built-in view is `agent.run.trace`. It is packaged from `src/trace/views/agent-run-trace.html` and opened through `DynamicViewSessionManager`; no new window system is introduced.

Trace auto-open is off by default. It opens when `openView: true` is passed to `traceSessionStart`, or when `ELIZA_TRACE_AUTO_OPEN=1` is set for dev/test runs.

## Limits

The store is in-memory and bounded:

- `ELIZA_TRACE_MAX_SESSIONS`, default `200`
- `ELIZA_TRACE_MAX_EVENTS_PER_SESSION`, default `5000`
- `ELIZA_TRACE_MAX_EVENT_PAYLOAD_BYTES`, default `262144`

Oversized payloads are replaced with an explicit trace payload summary so trace recording does not destabilize the host.

## Future Voice Stages

Voice will record the same trace model:

```text
VAD -> ASR partial -> LLM first token -> tool calls -> TTS first audio -> playback start
```

That belongs in the later voice phase, after this trace substrate is stable.
