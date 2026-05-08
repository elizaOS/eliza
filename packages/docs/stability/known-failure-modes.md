---
title: Known Failure Modes
---

# Known Failure Modes

This document catalogs known failure modes across the Eliza system, organized by subsystem. Each entry describes the observable symptoms, underlying root cause, any current mitigation in place, and the remaining gap or risk.

---

## Table of Contents

- [Runtime / Lifecycle](#runtime--lifecycle)
  - [F-01: Plugin loading order dependency](#f-01-plugin-loading-order-dependency)
  - [F-02: Coordinator bridges not re-wired after restart](#f-02-coordinator-bridges-not-re-wired-after-restart)
- [Chat / Streaming](#chat--streaming)
  - [F-03: SSE stream interruption on network blip](#f-03-sse-stream-interruption-on-network-blip)
  - [F-04: Insufficient credits fallback detection](#f-04-insufficient-credits-fallback-detection)
- [Connectors](#connectors)
  - [F-05: WhatsApp QR session state loss on restart](#f-05-whatsapp-qr-session-state-loss-on-restart)
  - [F-06: Discord/Telegram token expiry](#f-06-discordtelegram-token-expiry)
- [Knowledge](#knowledge)
  - [F-07: Knowledge service loading timeout](#f-07-knowledge-service-loading-timeout)
  - [F-08: Large document upload rejected](#f-08-large-document-upload-rejected)
- [Triggers](#triggers)
  - [F-09: Trigger execution during agent restart](#f-09-trigger-execution-during-agent-restart)
  - [F-10: dedupeKey assumes deterministic generation](#f-10-dedupekey-assumes-deterministic-generation)
- [Coding Agents / PTY](#coding-agents--pty)
  - [F-11: Coordinator wiring exhaustion](#f-11-coordinator-wiring-exhaustion)
  - [F-12: Deferred task delivery race](#f-12-deferred-task-delivery-race)
  - [F-13: Stall classification cascade](#f-13-stall-classification-cascade)
  - [F-14: WebSocket reconnect exhaustion](#f-14-websocket-reconnect-exhaustion)
- [Training](#training)
  - [F-15: Backend availability not validated](#f-15-backend-availability-not-validated)
- [General / UI](#general--ui)
  - [F-16: No React error boundary](#f-16-no-react-error-boundary)
  - [F-17: Hooks system untested](#f-17-hooks-system-untested)

---

## Runtime / Lifecycle

### F-01: Plugin loading order dependency

| Field | Detail |
|---|---|
| **Status** | **Open** |
| **Symptoms** | `undefined` service errors at startup. A plugin attempts to call a service registered by another plugin that has not yet loaded. |
| **Root cause** | There is no explicit dependency graph governing plugin load order. Plugins are loaded in an undefined order and may reference services registered by peers that have not completed initialization. |
| **Current mitigation** | Some plugins use retry loops to wait for dependent services to become available. |
| **Gap / Risk** | No formal DAG-based resolution. Retry loops are ad-hoc and inconsistent across plugins. A plugin that fails its retry window will surface a confusing runtime error with no indication of which dependency is missing. |

### F-02: Coordinator bridges not re-wired after restart

| Field | Detail |
|---|---|
| **Status** | **Open** |
| **Symptoms** | Coding agents become unresponsive after a runtime restart. Commands sent to agents receive no response. |
| **Root cause** | Coordinator bridges are wired at boot time. On restart, the runtime must re-establish these connections via a retry loop. |
| **Current mitigation** | A retry loop exists to re-wire bridges after restart. |
| **Gap / Risk** | If the retry loop exhausts its attempts, the failure is silent. No error is surfaced to the user, and coding agents remain permanently disconnected until a full process restart. |

---

## Chat / Streaming

### F-03: SSE stream interruption on network blip

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #806) |
| **Symptoms** | A chat response cuts off mid-stream. The user sees a partial message with no indication that the stream was interrupted. |
| **Root cause** | Server-Sent Events (SSE) have no built-in replay or resume mechanism. When the network connection drops, the stream terminates and there is no way to recover from the last received offset. |
| **Current mitigation** | SSE interruption detection with visual indicator and retry button in chat UI. |
| **Gap / Risk** | No automatic retry with offset tracking. The user loses the partial response and must re-trigger the full generation. On long responses this is especially costly in both time and tokens. |

### F-03b: Post-generation error replaces streamed text

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #1833) |
| **Symptoms** | The LLM streams a full reply successfully, but a post-action continuation fails. The already-streamed text is discarded and replaced with a generic "provider issue" message, confusing the user. |
| **Root cause** | The error handler did not distinguish between failures that occurred before any text was streamed and failures that occurred after. Both paths produced the same generic fallback reply. |
| **Current mitigation** | The streaming error handler now checks whether text was already delivered. If so, the streamed text is preserved in the final `done` SSE event instead of being replaced. Errors are logged for diagnosis. |
| **Gap / Risk** | None — the user retains the partial or complete reply that was already visible. |

### F-04: Insufficient credits fallback detection

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #806) |
| **Symptoms** | The user receives an empty response or a generic error message when the model provider returns a credit/quota exhaustion error. |
| **Root cause** | Provider-specific credit exhaustion errors are not fully mapped in the error handling pipeline. Some providers return non-standard error shapes that are not caught. |
| **Current mitigation** | Expanded credit exhaustion detection covers HTTP 402, 429+billing, and structured error shapes. |
| **Gap / Risk** | Incomplete error mapping means the user gets no actionable feedback. They cannot distinguish between a system bug and a billing issue. |

---

## Connectors

### F-05: WhatsApp QR session state loss on restart

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #826) |
| **Symptoms** | After a process restart, the WhatsApp connector requires the user to re-scan the QR code to re-authenticate. |
| **Root cause** | Session state is persisted to `authDir`, but `stop()` closed the socket without flushing pending credential writes. A `creds.update` event that fired but whose `saveCreds()` hadn't completed would lose session state. Additionally, no notification was emitted on `loggedOut` disconnect, and no logging indicated whether session restoration succeeded. |
| **Current mitigation** | `stop()` now flushes credentials via `saveCreds()` before closing the socket. `loggedOut` disconnect emits a `WHATSAPP_DISCONNECTED` runtime event for UI notification. Session restoration outcome is logged after `connect()`. |
| **Gap / Risk** | If the WhatsApp device is explicitly removed server-side, re-pairing via QR is still required (this is a WhatsApp protocol limitation, not a bug). |

### F-06: Discord/Telegram token expiry

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #806) |
| **Symptoms** | The Discord or Telegram connector stops working silently. Messages are no longer received or sent. |
| **Root cause** | There is no token refresh mechanism. When a token expires or is revoked, the connector enters a failed state without notification. |
| **Current mitigation** | Connector health monitor with WebSocket alerts on disconnect. |
| **Gap / Risk** | No user alert on token failure. The connector appears connected in the UI but is functionally dead. The user discovers the issue only when they notice messages are not being processed. |

---

## Knowledge

### F-07: Documents service loading timeout

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #806) |
| **Symptoms** | The knowledge tab in the dashboard appears empty or shows a loading spinner indefinitely. |
| **Root cause** | The embedding service can take more than 10 seconds to initialize on large databases. When this exceeds the configured timeout, the load fails. |
| **Current mitigation** | Shared documents service loader with configurable timeout and client retry UI. |
| **Gap / Risk** | The failure is silent. The UI does not indicate that loading timed out or provide a way to retry. The user sees an empty knowledge tab with no explanation. |

### F-08: Large document upload rejected

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #816) |
| **Symptoms** | Uploading a document larger than 32 MB fails. The upload is rejected by the server. |
| **Root cause** | The document upload body limit enforces a hard cap on upload size. |
| **Current mitigation** | Both upload endpoints (`/api/documents` and `/api/documents/bulk`) return a clear 413 error: "Document upload exceeds the 32 MB limit. Split large files into smaller parts before uploading." |
| **Gap / Risk** | No auto-chunking fallback. Users must split large files manually before uploading. |

---

## Triggers

### F-09: Trigger execution during agent restart

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #826) |
| **Symptoms** | A trigger fires during an agent restart, but the resulting action is lost. The trigger is consumed but the side effect never occurs. |
| **Root cause** | `dispatchInstruction()` throws when AutonomyService is unavailable during restart. The execution was recorded as an `error` run with `runCount` incremented, consuming `once` triggers or triggers at `maxRuns` despite never actually executing. |
| **Current mitigation** | `executeTriggerTask()` checks `isAutonomyServiceAvailable()` before dispatching. Scheduler-sourced triggers return `"skipped"` without incrementing `runCount` when the service is unavailable, allowing retry on the next scheduler cycle. Manual triggers bypass the guard since the user explicitly requested execution. |
| **Gap / Risk** | If the autonomy service remains unavailable for an extended period, scheduled triggers will keep skipping. No backlog replay mechanism exists, but triggers will execute on the next cycle once the service recovers. |

### F-10: dedupeKey assumes deterministic generation

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #811) |
| **Symptoms** | Duplicate triggers are created for what should be a single logical trigger. |
| **Root cause** | `buildTriggerConfig()` may produce different `dedupeKey` values for triggers that are semantically identical. The deduplication mechanism assumes that the key generation function is fully deterministic for equivalent inputs, but this is not guaranteed. |
| **Current mitigation** | Deterministic deduplication key generation. |
| **Gap / Risk** | No user-level deduplication control. Users cannot manually specify or override deduplication keys, and the system may create redundant triggers that fire multiple times for the same event. |

---

## Coding Agents / PTY

### F-11: Coordinator wiring exhaustion

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #795, #811) |
| **Symptoms** | Coding agents do not respond to commands. No error is shown in the UI. |
| **Root cause** | The SwarmCoordinator is not available after the retry loop exhausts its 15 attempts. The bridge connection to the coordinator fails permanently. |
| **Current mitigation** | System-warning WS event emitted when coordinator wiring fails; UI surfaces the error. |
| **Gap / Risk** | No user-visible alert after exhaustion. The coding agents section of the UI appears functional but is completely inert. The user has no indication that a restart is needed. |

### F-12: Deferred task delivery race

| Field | Detail |
|---|---|
| **Status** | **Fixed** (plugin-agent-orchestrator 0.3.4, PR #7; eliza PR #817) |
| **Symptoms** | The first task sent to a coding agent is not received. Subsequent tasks work normally. |
| **Root cause** | The listener must be attached before `pushDefaultRules` executes, which includes a 1500ms sleep. If the listener attachment is delayed (e.g., under heavy system load), the task delivery window is missed. |
| **Current mitigation** | Fixed ordering ensures the listener is attached before `pushDefaultRules` is called. A 30-second timeout fallback forces task delivery if `session_ready` is never received (covers edge cases where the ready detection pattern doesn't match a CLI update). |
| **Gap / Risk** | Timeout fallback is a last resort; if the CLI prompt changes significantly, the agent may not be fully ready when the task is force-delivered after 30s. |

### F-13: Stall classification cascade

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #795) |
| **Symptoms** | Stall responses are delayed across all coding agent sessions. A single stalled session blocks classification for others. |
| **Root cause** | The stall classification queue is serialized. Each classification requires an LLM call, and a slow LLM response blocks all subsequent classifications in the queue. |
| **Current mitigation** | 15s timeout guard on stall classification LLM calls prevents cascade blocking. |
| **Gap / Risk** | No timeout on the LLM classification call. A single slow or hung LLM request can cascade into multi-minute delays for all active sessions. No parallel classification or circuit breaker is in place. |

### F-14: WebSocket reconnect exhaustion

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #795, #811) |
| **Symptoms** | The terminal view in the UI goes dead. No further output is displayed and input is not accepted. No retry option is presented. |
| **Root cause** | The WebSocket connection to the PTY backend has a maximum of 15 reconnect attempts. Once exhausted, the connection is permanently dropped. |
| **Current mitigation** | ConnectionFailedBanner shows retry UI when WS reconnection exhausts attempts. |
| **Gap / Risk** | No banner or button to manually retry the connection after exhaustion. The user must refresh the entire page to re-establish the WebSocket connection. There is no visual indication that the connection was lost. |

---

## Training

### F-15: Backend availability not validated

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #811) |
| **Symptoms** | A training job is submitted and starts, but fails immediately or partway through execution. |
| **Root cause** | The system does not check for MLX or CUDA backend availability before accepting a training job submission. The job is dispatched to a backend that may not exist or may not have sufficient resources. |
| **Current mitigation** | Pre-submission backend availability validation. |
| **Gap / Risk** | No pre-submission validation. Users waste time waiting for a job that was doomed to fail. The error message from the failed job may not clearly indicate that the required backend is unavailable. |

---

## General / UI

### F-16: No React error boundary

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #795) |
| **Symptoms** | A white screen appears in the browser. The entire UI is unresponsive. |
| **Root cause** | No `ErrorBoundary` component wraps the top-level routes. An unhandled exception in any React component propagates to the root and unmounts the entire application. |
| **Current mitigation** | React ErrorBoundary wrapping ViewRouter catches render crashes with fallback UI. |
| **Gap / Risk** | A single component error crashes the entire UI. There is no fallback UI, no error message, and no way to recover without a page refresh. Errors in rarely-used components can take down the entire dashboard. |

### F-17: Hooks system untested

| Field | Detail |
|---|---|
| **Status** | **Fixed** (PR #813) |
| **Symptoms** | Unknown. Failures in the hooks system may go undetected. |
| **Root cause** | The hooks discovery and loader modules had zero test coverage. |
| **Current mitigation** | Registry tested in `registry.test.ts`; eligibility tested in `hooks.test.ts`; discovery and loader tested in PR #813. All 5 hooks source modules now have unit coverage. |
| **Gap / Risk** | Integration-level coverage (full filesystem + real imports) remains limited to unit tests with mocked I/O. |
