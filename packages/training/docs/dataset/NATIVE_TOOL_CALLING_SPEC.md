# Native tool-calling corpus spec

This is the training contract for the native tool-calling refactor. It
replaces the legacy `expectedResponse` string contract where the supervised
target was usually TOON and sometimes XML or raw `<think>...</think>` text.

Every native row must be JSON. TOON may only appear inside migration metadata
when a compatibility reader converted an old row.

## Goals

- Train the exact model calls in the v5 runtime plan: Stage 1
  `message_handler`, planner, sub-planner, and evaluator.
- Preserve source provenance and conversion quality so weak bootstrap data can
  be down-weighted or excluded later.
- Keep tool calls as provider-native function calls, not `TASK_CALL` wrapped in
  a text format.
- Support append-only trajectory exports for Atropos and RL without requiring
  every bootstrap dataset to be a complete trajectory.

## Top-level row

```jsonc
{
  "schema": "eliza.native_tool_calling.v1",
  "id": "sha256-derived stable id",
  "stage": "message_handler | planner | sub_planner | evaluator | trajectory",
  "source": {
    "dataset": "slug from datasets.yaml",
    "normalizer": "legacy normalizer or native adapter name",
    "license": "best effort license string",
    "split": "train | validation | val | test",
    "originalId": "upstream row id when available",
    "conversion": "native_direct | legacy_toon_compat | legacy_xml_compat | inferred | synthetic"
  },
  "messages": [
    {"role": "system", "content": "optional system/developer instruction"},
    {"role": "user", "content": "current user message"}
  ],
  "contexts": ["calendar", "email"],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "CALENDAR_FIND_EVENTS",
        "description": "Find matching calendar events.",
        "parameters": {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      }
    }
  ],
  "input": {
    "contextObject": {},
    "plannedQueue": [],
    "events": []
  },
  "output": {},
  "quality": {
    "rating": "gold | silver | bronze | quarantine",
    "strengths": [],
    "weaknesses": [],
    "recommendedWeight": 1.0,
    "requiresReview": false
  }
}
```

`messages` use OpenAI-compatible chat roles. Tool-result bootstrap data may use
`tool` role messages, but new generated data should prefer full trajectory
events in `input.events` or `output.trajectory.events`.

## Stage outputs

### `message_handler`

Supervises Stage 1. This is not the old `shouldRespond` schema.

```jsonc
{
  "output": {
    "messageHandler": {
      "action": "RESPOND | IGNORE | STOP",
      "simple": true,
      "contexts": [],
      "thought": "short internal routing thought",
      "reply": "optional direct reply when contexts is empty"
    }
  }
}
```

Rules:

- `contexts.length === 0 && simple === true` means direct reply and stop.
- `contexts.length > 0` means planner will run. `simple` is only telemetry.
- Old `primaryContext` and `secondaryContexts` convert into `contexts`.
- Old `evidenceTurnIds`, provider lists, and complexity dimensions are dropped.

### `planner`

Supervises the outer planner. The target is a native tool-call queue plus any
assistant text the provider returned.

```jsonc
{
  "output": {
    "planner": {
      "text": "optional assistant text from the planner call",
      "toolCalls": [
        {
          "id": "call_...",
          "name": "CALENDAR_FIND_EVENTS",
          "args": {"query": "lunch with Sam"},
          "contextScope": "calendar",
          "status": "queued"
        }
      ],
      "finishReason": "tool_calls"
    }
  }
}
```

Terminal tools are represented the same way:

- `REPLY` with args `{ "text": "..." }`
- `IGNORE` with args `{ "reason": "..." }`
- `STOP` with args `{ "reason": "..." }`

Legacy `TASK_CALL` rows unwrap to the actual native function name. For example,
old `actions[0].name = TASK_CALL` with `params.tool = "get_weather"` becomes
`toolCalls[0].name = "get_weather"` and `toolCalls[0].args =
params.arguments`.

### `sub_planner`

Same shape as `planner`, with a scoped parent action:

```jsonc
{
  "input": {
    "parentToolCall": {"id": "call_parent", "name": "CALENDAR", "args": {}},
    "allowedToolNames": ["CALENDAR_FIND_EVENTS", "CALENDAR_CREATE_EVENT", "REPLY", "STOP"]
  },
  "output": {
    "planner": {
      "text": "",
      "toolCalls": []
    }
  }
}
```

Sub-planner examples should only include the parent action's declared subtree
plus terminal tools.

### `evaluator`

Supervises central post-action evaluation.

```jsonc
{
  "output": {
    "evaluation": {
      "success": true,
      "decision": "FINISH | NEXT_RECOMMENDED | CONTINUE",
      "thought": "why this decision is correct",
      "messageToUser": "optional progress or final user-visible message",
      "copyToClipboard": {
        "title": "optional title",
        "content": "clipboard content",
        "tags": ["optional"]
      },
      "recommendedToolCallId": "call_..."
    }
  }
}
```

Bootstrap sources rarely contain real post-action evaluation. Inferred
evaluator rows are allowed, but they must be marked `quality.rating =
"bronze"` or `quarantine` unless a tool result and user goal are both present.

### `trajectory`

Full trajectory exports mirror the runtime `ContextObject` and are the
preferred format for Atropos/RL:

```jsonc
{
  "output": {
    "trajectory": {
      "contextObjectVersion": 5,
      "trajectoryId": "...",
      "events": [],
      "metrics": {}
    }
  }
}
```

## Required conformance checks

All native rows must pass:

- JSON decode and schema version check.
- Known `stage`.
- Non-empty `messages` unless `stage === "trajectory"`.
- For planner/sub-planner rows, every `toolCalls[].name` must be non-empty and
  every `args` value must be JSON.
- For planner/sub-planner rows, `tools` must include definitions for all
  non-terminal tool call names when the source provides tool specs.
- For message-handler rows, `action` must be `RESPOND`, `IGNORE`, or `STOP`.
- For evaluator rows, `decision` must be `FINISH`, `NEXT_RECOMMENDED`, or
  `CONTINUE`.
- Every row must carry `source.dataset`, `source.license`, `source.split`,
  `quality.rating`, and `quality.weaknesses`.

## Bootstrap source quality tiers

- `gold`: real Eliza trajectories or sources with native tool calls, tool
  results, and multi-step traces.
- `silver`: high-quality function-calling datasets with clear tool schemas but
  no real execution/evaluation result.
- `bronze`: useful single-turn function-calling or reply data where contexts,
  planner thoughts, or evaluator decisions are inferred.
- `quarantine`: reasoning-only, workflow-only, harmful/harmless calibration,
  malformed, gated, missing local, or license-unclear sources. Do not mix into
  the default SFT corpus without an explicit override.

## Migration policy

The compatibility converter may read legacy TOON/XML rows to bootstrap native
records, but its output must be native JSON. New adapters should bypass TOON
entirely and emit this spec directly from source rows.
