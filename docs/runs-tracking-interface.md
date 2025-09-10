### Runs Tracking and Interface Implementation Plan

Purpose: Ship a production-ready Runs timeline UI in `@client` backed by server APIs and consistent run logging across the runtime and bootstrap services.

Scope covers: event persistence, server endpoints, API client, UI, and tests. Tasks are sequenced and sized to be roughly equal effort. Each task includes acceptance criteria and code pointers.

Glossary
- **Run**: The lifecycle window from message processing start to completion/timeout. Identified by `runId`.
- **Action event**: Start/completion of an action within a run; includes `actionId`, `actionName`, `runId`.
- **Model call**: `useModel` invocation (LLM, embedding); logs include `runId` and `executionTime`.

Assumptions
- We aggregate from the existing `logs` table in `@plugin-sql` (no new DB table).
- We log additional structured entries for run and action lifecycle events.
- Server aggregates per-run timelines by filtering `body.runId` and `type`.

Out-of-scope (for now)
- DB JSONB index and specialized adapter queries (added in a follow‑up optimization).
- Cross-agent runs.

Deliverables
- New server endpoints: list runs and run detail timeline.
- New client pages: Runs list and Run detail timeline.
- Consistent log entries for RUN_* and ACTION_* phases with `runId`.
- Tests across layers.

Sequential Task List (equal-sized, ~0.5–1.5h each)

1) Persist RUN_* events to logs in bootstrap plugin
- Summary: On `RUN_STARTED`, `RUN_ENDED`, `RUN_TIMEOUT`, write a log entry `type: 'run_event'` with `runId`, `status`, `messageId`, `roomId`, `entityId`, `startTime`, `endTime?`, `duration?`, `error?`, `source`, `metadata?`.
- Code pointers: `packages/plugin-bootstrap/src/index.ts` (events map near bottom). Add handlers for `EventType.RUN_STARTED`, `RUN_ENDED`, `RUN_TIMEOUT` calling `runtime.adapter.log(...)`.
- Acceptance: Emitting those events produces rows in `logs` with `type='run_event'` and the fields above.

2) Persist ACTION_STARTED to logs
- Summary: On `EventType.ACTION_STARTED`, write `type: 'action_event'` with `runId`, `actionId`, `actionName`, `roomId`, `messageId`, `timestamp`, `planStep?`.
- Code pointers: `packages/core/src/runtime.ts` emits ACTION_STARTED; add plugin handler in `packages/plugin-bootstrap/src/index.ts` to log.
- Acceptance: Starting any action writes a single `action_event` row referencing the same `runId` context as action result logs.

3) Attach runId to evaluator logs
- Summary: Ensure `AgentRuntime.evaluate(...)` includes `runId: runtime.getCurrentRunId()` in the body of `type:'evaluator'` logs.
- Code pointers: `packages/core/src/runtime.ts` (evaluate → `this.adapter.log({ type: 'evaluator', body: ... })`).
- Acceptance: Evaluator logs contain `body.runId` when invoked during runs.

4) Propagate runId through queueEmbeddingGeneration
- Summary: Include `runId` on `EMBEDDING_GENERATION_REQUESTED` payload; update service to propagate it.
- Code pointers: `packages/core/src/runtime.ts` (`queueEmbeddingGeneration` emit payload) and `packages/plugin-bootstrap/src/services/embedding.ts` (handleEmbeddingRequest).
- Acceptance: Requests carry `payload.runId` when called during a run; service stores it on its queue item.

5) Log embedding lifecycle events with runId (service)
- Summary: In `EmbeddingGenerationService`, on completion/failure, write `type:'embedding_event'` logs with `runId`, `memoryId`, `duration`, `status`.
- Code pointers: `packages/plugin-bootstrap/src/services/embedding.ts` (`generateEmbedding`, failure branch in `processQueue`).
- Acceptance: Successful and failed embedding generations produce logs with `body.runId` when available.

6) Normalize multi-action plan run linkage
- Summary: When `processActions` creates its action-plan run, also include `parentRunId: runtime.getCurrentRunId()` inside action logs so the UI can nest under the message run.
- Code pointers: `packages/core/src/runtime.ts` (`processActions` where `runId` and `adapter.log({ type:'action' ... })` are set). Add `parentRunId` without changing current `runId` semantics.
- Acceptance: Action result logs include both `runId` (plan run) and `parentRunId` (message run) when a parent exists.

7) Add server runs router scaffolding
- Summary: Create `packages/server/src/api/agents/runs.ts`; mount in `packages/server/src/api/agents/index.ts`.
- Endpoints: `GET /api/agents/:agentId/runs` and `GET /api/agents/:agentId/runs/:runId`.
- Acceptance: Router compiles; endpoints return stubbed shapes (200) with empty arrays.

8) Implement list runs aggregation
- Summary: Fetch recent `run_event` logs for agent/room; group by `runId`; enrich with counts from `action`, `action_event`, `useModel:*` filtered by `runId`.
- API: `GET /api/agents/:agentId/runs?roomId=&status=&limit=20&from=&to=`
- Response:
```json
{
  "runs": [
    {
      "runId": "550e8400-e29b-41d4-a716-446655440000",
      "status": "completed|timeout|error|started",
      "startedAt": 1730000000000,
      "endedAt": 1730000003456,
      "durationMs": 3456,
      "messageId": "550e8400-e29b-41d4-a716-446655440001",
      "roomId": "550e8400-e29b-41d4-a716-446655440002",
      "entityId": "550e8400-e29b-41d4-a716-446655440003",
      "counts": {
        "actions": 2,
        "modelCalls": 5,
        "errors": 0,
        "evaluators": 1
      },
      "metadata": {
        "entityName": "user123",
        "source": "messageHandler"
      }
    }
  ],
  "total": 147,
  "hasMore": true
}
```
- Acceptance: Returns paginated runs sorted by `startedAt` desc; counts accurate; status reflects latest event.

9) Implement run detail aggregation (timeline)
- Summary: Collect events for a run from `run_event`, `action_event`, `action`, `useModel:*`, `evaluator`, `embedding_event`. Sort chronologically and shape as a timeline list.
- API: `GET /api/agents/:agentId/runs/:runId?roomId=`
- Response:
```json
{
  "summary": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "startedAt": 1730000000000,
    "endedAt": 1730000003456,
    "durationMs": 3456,
    "messageId": "550e8400-e29b-41d4-a716-446655440001",
    "roomId": "550e8400-e29b-41d4-a716-446655440002",
    "entityId": "550e8400-e29b-41d4-a716-446655440003",
    "counts": { "actions": 2, "modelCalls": 5, "errors": 0 },
    "metadata": { "entityName": "user123" }
  },
  "events": [
    {
      "type": "RUN_STARTED",
      "timestamp": 1730000000000,
      "data": {
        "source": "messageHandler",
        "messageContent": { "text": "Hello" }
      }
    },
    {
      "type": "ACTION_STARTED", 
      "timestamp": 1730000000500,
      "data": {
        "actionId": "550e8400-e29b-41d4-a716-446655440004",
        "actionName": "REPLY",
        "planStep": "1/2"
      }
    },
    {
      "type": "MODEL_USED",
      "timestamp": 1730000000800,
      "data": {
        "modelType": "TEXT_LARGE",
        "provider": "openai",
        "executionTime": 420,
        "actionContext": {
          "actionName": "REPLY",
          "actionId": "550e8400-e29b-41d4-a716-446655440004"
        }
      }
    },
    {
      "type": "ACTION_COMPLETED",
      "timestamp": 1730000002000,
      "data": {
        "actionId": "550e8400-e29b-41d4-a716-446655440004",
        "actionName": "REPLY",
        "success": true,
        "durationMs": 1500,
        "result": { "text": "Hello! How can I help?" }
      }
    },
    {
      "type": "EVALUATOR_COMPLETED",
      "timestamp": 1730000002800,
      "data": {
        "evaluatorName": "goal_tracker",
        "success": true
      }
    },
    {
      "type": "RUN_ENDED",
      "timestamp": 1730000003456,
      "data": {
        "status": "completed",
        "totalDurationMs": 3456
      }
    }
  ]
}
```
- Acceptance: Timeline events chronologically ordered; action start/complete pairs matched; model calls linked to actions; durations computed.

10) Server tests for runs router
- Summary: Unit tests for grouping and timeline shaping; mocks for `runtime.getLogs`.
- Code pointers: `packages/server/src/api/**/__tests__` (create folder), Vitest setup.
- Acceptance: All new tests pass; edge cases (in-progress run without end, no action events) covered.

11) API client types and service
- Summary: Add `types/runs.ts` (`RunSummary`, `RunDetail`, `RunEvent`), new `services/runs.ts` with `listRuns` and `getRun`, export in `src/index.ts`.
- Code pointers: `packages/api-client/src/types`, `packages/api-client/src/services`.
- Types:
```typescript
export interface RunSummary {
  runId: UUID;
  status: 'completed' | 'timeout' | 'error' | 'started';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  messageId: UUID;
  roomId: UUID;
  entityId: UUID;
  counts: {
    actions: number;
    modelCalls: number;
    errors: number;
    evaluators: number;
  };
  metadata?: {
    entityName?: string;
    source?: string;
    [key: string]: any;
  };
}

export interface RunDetail {
  summary: RunSummary;
  events: RunEvent[];
}

export interface RunEvent {
  type: 'RUN_STARTED' | 'RUN_ENDED' | 'ACTION_STARTED' | 'ACTION_COMPLETED' | 'MODEL_USED' | 'EVALUATOR_COMPLETED';
  timestamp: number;
  data: Record<string, any>;
}

export interface ListRunsParams {
  roomId?: UUID;
  status?: string;
  limit?: number;
  from?: number;
  to?: number;
}
```
- Service methods:
```typescript
async listRuns(agentId: UUID, params?: ListRunsParams): Promise<{ runs: RunSummary[]; total: number; hasMore: boolean }>
async getRun(agentId: UUID, runId: UUID, roomId?: UUID): Promise<RunDetail>
```
- Acceptance: Type-safe methods compile and are consumable from the client; matches server response shapes exactly.

12) Client data hooks
- Summary: Add React Query hooks `useListRuns(agentId, params)` and `useRunDetail(agentId, runId)` using `createElizaClient()`.
- Code pointers: `packages/client/src/hooks/`.
- Hook signatures:
```typescript
function useListRuns(
  agentId: UUID | undefined, 
  params?: ListRunsParams & { enabled?: boolean; refetchInterval?: number }
): UseQueryResult<{ runs: RunSummary[]; total: number; hasMore: boolean }>

function useRunDetail(
  agentId: UUID | undefined,
  runId: UUID | undefined,
  options?: { roomId?: UUID; enabled?: boolean; refetchInterval?: number }
): UseQueryResult<RunDetail>
```
- Acceptance: Hooks return typed data, manage loading/error states, support polling via refetchInterval; disabled when IDs undefined.

13) Runs List UI
- Summary: Build `RunList.tsx` (filters: agent, room, status, time); table/cards with status badges, durations, counts; polling.
- Code pointers: `packages/client/src/components/runs/RunList.tsx`.
- Acceptance: Renders mocked and live data; navigates to detail view.

14) Run Detail Timeline UI
- Summary: Build `RunDetail.tsx` with a primary bar (run duration) and rows for actions, model calls, and evaluators; error/timeout styling.
- Code pointers: `packages/client/src/components/runs/RunDetail.tsx`.
- Acceptance: Displays a coherent timeline from the API; handles in-progress runs gracefully.

15) Integrate Runs into navigation
- Summary: Add a Runs tab/page (global or under Agent details) and routes. Preserve existing layout and theming.
- Code pointers: `packages/client/src` router/menu components.
- Acceptance: Users can reach Runs from the UI; deep-linking to `/:agentId/runs/:runId` works.

16) (Optional) Live updates via Socket.IO
- Summary: Broadcast minimal `run_event` and `action_event` messages from server; client subscribes to update active runs in real time.
- Code pointers: Server `packages/server/src/socketio`, Client `packages/client/src/lib/socketio-manager.ts`.
- Acceptance: When enabled, detail view updates without polling.

Risk/Edge Cases
- In-progress run: no end event → compute duration as `now - startTime`.
- Legacy logs: no `run_event` rows → tolerate and display limited timelines.
- Initialization calls (e.g., embedding dimension) should be tagged `system_init` to avoid polluting lists.

Validation Checklist (final)
- Emitting RUN_* and ACTION_* yields expected log rows with `runId`.
- List and detail endpoints return correct, stable shapes.
- Client list and timeline render with both old and new agents.
- Unit tests and basic E2E flows pass in CI.


