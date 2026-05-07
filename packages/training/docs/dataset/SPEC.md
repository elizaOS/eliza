# eliza-1 training corpus — legacy record spec

This document describes the current TOON-era `ElizaRecord` contract. The v5
native tool-calling migration uses
[`NATIVE_TOOL_CALLING_SPEC.md`](NATIVE_TOOL_CALLING_SPEC.md) for new bootstrap
data, planner/evaluator rows, and Atropos JSON exports.

This document is the contract between **dataset adapters** (everything in
`scripts/sources/`, `scripts/lib/adapters.py`, the synth pipeline, and the
nubilio normalizer) and **training consumers** (`scripts/training/*.py`,
`scripts/pack_dataset.py`, the schema validator
`scripts/validate_eliza_schema.py`). Every record on disk under
`data/normalized/`, `data/synthesized/`, `data/together/`, and
`data/final/` MUST conform to it.

If a sample on HuggingFace doesn't validate against this spec, the
upstream adapter is wrong, not the consumer.

---

## 1. Why this shape

Eliza's runtime makes two model calls per turn:

1. **shouldRespond** — given recent context, decide `RESPOND | IGNORE |
   STOP` (and which routing context applies). Defined in
   `eliza/packages/core/src/prompts.ts` as
   [`shouldRespondTemplate`](../../../eliza/packages/core/src/prompts.ts).
2. **messageHandler** — if `RESPOND`, generate `thought + actions +
   providers + text + simple`. Same file, exported as
   [`messageHandlerTemplate`](../../../eliza/packages/core/src/prompts.ts).

Both templates use **TOON** (token-oriented object notation, an
indentation-based YAML-ish format) for the model's output. The training
corpus mirrors the prompt input on the **input** side and the model
output on the **output** side. That's the entire reason for this schema.

A "tool call" in eliza is **just an action** — there is no separate tool
schema in the runtime. Tool dispatch happens through the `TASK_CALL`
action whose `params` carry the tool name + JSON arguments. This means
records normalized from `glaive-fc-v2`, `bitagent-tool-calling`,
`deepfabric-github-mcp`, etc. all collapse into the same wire shape:
`actions[1]: - name: TASK_CALL; params: tool: <name>; arguments: {...}`.
This is intentional — it's how the live runtime sees them too.

---

## 2. Top-level record (canonical)

```jsonc
{
  "roomName":         "<str: stable per-conversation id>",
  "agentId":          "<str: which Eliza persona authored expectedResponse>",
  "memoryEntries":    [/* prior conversation turns, ordered oldest -> newest */],
  "currentMessage":   {/* the message that triggered the model call */},
  "expectedResponse": "<str: literal TOON the model is supposed to emit>",
  "availableActions": [/* List[str] OR List[dict] — see §5 */],
  "metadata":         {/* see §6 */}
}
```

All seven top-level keys are **REQUIRED**.

`expectedResponse` is **the literal string the SFT loss is computed on.**
It is not parsed; it is shipped to the model verbatim. Any TOON-vs-JSON
or task-type-specific shape lives entirely inside this string.

### Top-level field types

| Field             | Type             | Required | Notes                                                     |
|-------------------|------------------|----------|-----------------------------------------------------------|
| `roomName`        | `str`            | yes      | Free-form conversation id; stable within a trajectory.    |
| `agentId`         | `str`            | yes      | Persona name (`remilio-nubilio`, `agent`, `juno`, ...).   |
| `memoryEntries`   | `list[dict]`     | yes      | Empty list is valid. Each entry: §3.                      |
| `currentMessage`  | `dict`           | yes      | The triggering message. §4.                               |
| `expectedResponse`| `str`            | yes      | Non-empty. Literal TOON document for the assistant turn.  |
| `availableActions`| `list[str|dict]` | yes      | Empty list is valid. §5.                                  |
| `metadata`        | `dict`           | yes      | Provenance + split. §6.                                   |

The schema validator that enforces this is
[`scripts/validate_eliza_schema.py`](../../scripts/validate_eliza_schema.py).
Last run: 0 violations across 1,124,594 records.

---

## 3. `memoryEntries[i]` — prior turns

Each entry represents one prior message in the conversation, in the
order the agent saw them.

```jsonc
{
  "role":    "<str>",   // REQUIRED
  "speaker": "<str>",   // optional; falls back to role
  "content": "<str>",   // REQUIRED, may be empty
  "channel": "<str>"    // optional; e.g. "discord", "telegram", "internal"
}
```

The valid roles are:

```
user, assistant, system, tool, tool_output, reasoning,
agent, memory, environment, ipython
```

`agent`, `memory`, `environment`, and `ipython` are mostly emitted by
upstream tool-use corpora (`open-paws-tool-use`, `dolci-instruct-tool-use`,
`hermes-tool-use`) and represent non-conversational context the runtime
exposes as memory.

---

## 4. `currentMessage` — the triggering input

```jsonc
{
  "role":    "user",          // REQUIRED, almost always "user"
  "speaker": "user",          // optional
  "content": "<str>",         // REQUIRED, non-empty
  "channel": "internal"       // optional
}
```

For `task_type=agent_trace` records, `content` typically starts with
`task: Generate dialog and actions for <agentName>.\n\ncontext:\n...`
because the upstream record was already a full Eliza prompt — the
adapter just preserves it. For `reply`, `tool_call`, `shell_command`,
the content is the user's natural message.

For `task_type=should_respond` and friends, `content` is a synthesized
multi-turn dialogue dump where the model has to decide whether to
respond.

---

## 5. `availableActions` — runtime surface

This field tells the model which actions / tools were live at that turn.
Two shapes are accepted:

### Shape A — `List[str]` (most common)

```json
["REPLY", "IGNORE", "TASK_CALL"]
```

Plain action names. Used by `nubilio-trajectories`, `agent-trove`,
`bitagent-tool-calling`, `glaive-fc-v2`, every synth set, and most of
the corpus.

### Shape B — `List[dict]` (descriptions inline)

```json
[
  {"name": "REPLY",     "description": "..."},
  {"name": "TASK_CALL", "description": "..."}
]
```

Used by adapters that wanted to surface action docstrings to the model
during training. Both shapes are valid; the validator accepts either.

---

## 6. `metadata` — provenance + split

```jsonc
{
  "task_type":      "<str>",   // REQUIRED — see §7
  "source_dataset": "<str>",   // REQUIRED — slug from datasets.yaml
  "split":          "train | val | test", // REQUIRED
  "license":        "<str>",   // optional but recommended
  "original_id":    "<str>",   // optional — id in upstream
  // adapter-specific extras (preserved verbatim):
  "nubilio_source_file":     "...",
  "nubilio_response_format": "xml-response | yaml-thought | json-obj | raw | md-fence | json-array",
  "system_prompt":           "...",
  "scenario_id":             "...",
  ...
}
```

The validator only enforces `task_type` and `split` as `str`. Everything
else is descriptive but uniformly preserved through the pipeline.

---

## 7. `task_type` taxonomy

Each `task_type` shapes what the `expectedResponse` string looks like.
This is the closest thing the corpus has to a "wire format" — the loss
is computed on `expectedResponse`, so this is how the model learns to
output different things.

Counts below are from the first 200,000 records of the canonical
`train.jsonl` (so they reflect distribution, not absolute totals).

| `task_type`         | Count   | Output schema (TOON)                                                    | Sample                                                        |
|---------------------|---------|-------------------------------------------------------------------------|---------------------------------------------------------------|
| `reply`             | 106,382 | `thought + text` (sometimes `actions[1]: - name: REPLY`)                | [reply.md](samples/reply.md)                                  |
| `agent_trace`       |  43,266 | `thought + actions + providers + text + simple`                         | [agent_trace.md](samples/agent_trace.md)                      |
| `shell_command`     |  21,781 | `thought + actions[1]: - name: SHELL_COMMAND; params: ...`              | [shell_command.md](samples/shell_command.md)                  |
| `reasoning_cot`     |  18,163 | Chain-of-thought reply with reasoning trace                             | [reasoning_cot.md](samples/reasoning_cot.md)                  |
| `mcp_tool_call`     |   9,697 | `thought + actions[1]: - name: TASK_CALL; params: tool, arguments`      | [mcp_tool_call.md](samples/mcp_tool_call.md)                  |
| `tool_call`         |     522 | identical wire shape to `mcp_tool_call`                                 | [tool_call.md](samples/tool_call.md)                          |
| `claude_distill`    |     189 | distilled assistant turn; may include `<think>...</think>` blocks       | [claude_distill.md](samples/claude_distill.md)                |
| `dialogue_routing`  |  varies | `name + reasoning + action + primaryContext + secondaryContexts + evidenceTurnIds` | [dialogue_routing.md](samples/dialogue_routing.md) |
| `should_respond`    |  varies | same shouldRespond schema as above                                      | [should_respond_routing.md](samples/should_respond_routing.md)|
| `multiparty_should_respond` | varies | same shouldRespond schema, multi-party participants A/B/C/D     | [multiparty_should_respond.md](samples/multiparty_should_respond.md) |

**Key insight: `tool_call` and `mcp_tool_call` are the same wire shape.**
The only differences are `metadata.source_dataset` (which corpus it came
from) and which tool namespaces appear. From the model's perspective
they are indistinguishable, which mirrors the runtime: a `TASK_CALL`
action targeting a builtin tool and a `TASK_CALL` action targeting an
MCP server look identical at the action layer.

---

## 8. nubilio specifically

Nubilio is the `remilio-nubilio` Discord-bot trajectory dump (proprietary
license, `weight: 3.0` in `datasets.yaml`). It's our highest-quality
in-the-wild eliza data because it comes from an actual long-running
deployed agent (`milady.nubs.site`), not synthesized prompts.

- **5,041 records** across two upstream files:
  - `action_planner_trajectories.jsonl` — 3,241 records → `task_type=agent_trace`
  - `response_trajectories.jsonl` — 1,800 records → `task_type=reply`
- The original responses came in **6 different surface formats**:

  | `nubilio_response_format` | Count | What it looked like upstream                              |
  |---------------------------|-------|-----------------------------------------------------------|
  | `xml-response`            | 2,896 | `<thought>...</thought><actions>...</actions>...`         |
  | `yaml-thought`            |   819 | `thought: ...\nactions: [...]`                            |
  | `json-obj`                |   613 | `{"thought":"...","actions":[...]}`                       |
  | `raw`                     |   390 | unstructured text                                         |
  | `md-fence`                |   263 | TOON inside ```` ```toon ```` blocks                      |
  | `json-array`              |    60 | `[{"name":"REPLY",...}]`                                  |

  The nubilio adapter normalizes **all six** of these to canonical TOON
  before the record reaches `expectedResponse`. The original surface
  format is preserved on `metadata.nubilio_response_format` so we can
  audit / re-balance later.

- The `system_prompt` for every nubilio record is preserved verbatim on
  `metadata.system_prompt`. That's the literal Discord-bot persona
  document — see the sample for the full text.

Real records:

- [`samples/nubilio_agent_trace.md`](samples/nubilio_agent_trace.md) — full
  action plan from nubilio.
- [`samples/nubilio_reply.md`](samples/nubilio_reply.md) — direct reply.

---

## 9. shouldRespond / dialogue_routing — the routing decision

Eliza's runtime makes a `shouldRespond` decision **before** the
messageHandler runs. The training corpus models this with three closely
related task types:

- `should_respond` — single-agent gate: respond / ignore / stop.
- `multiparty_should_respond` — multi-party room (A/B/C/D speakers); same
  TOON output schema but the predicted `name` rotates among participants.
- `dialogue_routing` — same shape, also covers stop / contextswitch
  cases.

Output schema (verbatim from
[`shouldRespondTemplate`](../../../eliza/packages/core/src/prompts.ts) ):

```toon
name: <agentName>
reasoning: <one-line justification>
action: RESPOND | IGNORE | STOP
primaryContext: <one of available_contexts, or "general">
secondaryContexts: <comma-separated, may be empty>
evidenceTurnIds: <comma-separated message ids, may be empty>
```

Examples:

- [`samples/should_respond_routing.md`](samples/should_respond_routing.md)
- [`samples/multiparty_should_respond.md`](samples/multiparty_should_respond.md)
- [`samples/dialogue_routing.md`](samples/dialogue_routing.md)

---

## 10. messageHandler — the action plan

The "main" model call. Output schema (verbatim from
[`messageHandlerTemplate`](../../../eliza/packages/core/src/prompts.ts)):

```toon
thought: <short plan>
actions[N]:
  - name: <ACTION_NAME>
    params:
      <key>: <value>
providers[M]:
  - <providerName>
text: <next message for the agent>
simple: true | false
```

- `thought`: short plan, always present.
- `actions[N]`: ordered list. Empty (`actions[0]`) is valid for pure
  replies that don't need explicit actions, though most replies still
  carry `actions[1]: - name: REPLY`.
- `providers[M]`: comma-separated provider names, or empty.
- `text`: the user-facing message; empty when the action will produce
  the final answer.
- `simple`: `true` only when `text` itself should be sent directly as
  the final reply without running `REPLY` again.

**Tool calls live inside `actions`.** The `TASK_CALL` action's `params`
carry `tool` and `arguments`:

```toon
actions[1]:
  - name: TASK_CALL
    params:
      tool: add_issue_comment
      arguments:
        owner: octocat
        repo:  Spoon-Knife
        issue_number: 123
        body:  "Resolved the review comment."
```

This is identical whether the tool is a builtin, a plugin action with
side-effects, or an MCP-served tool. We do not have a separate
`tool_calls` field — that's a deliberate design decision so the model
sees one action vocabulary, not two.

Examples:

- [`samples/agent_trace.md`](samples/agent_trace.md) — full plan.
- [`samples/tool_call.md`](samples/tool_call.md) — TASK_CALL dispatch.
- [`samples/mcp_tool_call.md`](samples/mcp_tool_call.md) — same shape, MCP tool.
- [`samples/shell_command.md`](samples/shell_command.md) — SHELL_COMMAND action.
- [`samples/reply.md`](samples/reply.md) — minimal reply.

---

## 11. "Other formats" comparison

Some upstream sources use different JSON shapes (e.g. OpenAI
`tool_calls`, ShareGPT `from/value`, Hermes `<tool_call>...</tool_call>`).
**All of these are normalized at adapter time** by
`scripts/lib/adapters.py` so the on-disk record always matches §2.

Quick mapping of the three most common upstream shapes we re-shape:

| Upstream shape                                                              | Our normalized form                                            |
|-----------------------------------------------------------------------------|----------------------------------------------------------------|
| OpenAI tool_calls: `{"role":"assistant","tool_calls":[{"function":{...}}]}` | `actions[1]: - name: TASK_CALL; params: tool: <fn>; arguments: <args>` |
| Hermes XML: `<tool_call>{"name":"...","arguments":{...}}</tool_call>`       | same as above                                                  |
| ShareGPT-style assistant text: `"FINAL: <answer>"`                          | `text: <answer>; simple: true; actions[1]: - name: REPLY`      |

If a source's wire format isn't listed and you see records that look
different on disk, that's an adapter bug — file it and we'll fix the
normalizer.

---

## 12. Verifying the corpus

Schema check:

```bash
python3 scripts/validate_eliza_schema.py data/final/train.jsonl
python3 scripts/validate_eliza_schema.py data/final/val.jsonl
python3 scripts/validate_eliza_schema.py data/final/test.jsonl
```

All three should print `VERDICT: PASS — every record conforms to schema`.
Last full run (2026-05-04) was 0 violations across all 1,124,594
records.

Distribution check:

```bash
python3 scripts/scan_trivial_thoughts.py data/final/train.jsonl
python3 scripts/audit_pipeline_shapes.py data/final/train.jsonl
```

---

## 13. How to actually look at one

The fastest way to manually inspect a record:

```bash
# Pull a specific line and pretty-print it
python3 -c "import json,sys; print(json.dumps(json.loads(open('data/final/train.jsonl').readlines()[42]), indent=2))" | less

# Or filter by task_type
python3 -c "
import json
for line in open('data/final/train.jsonl'):
    rec = json.loads(line)
    if rec['metadata'].get('task_type') == 'mcp_tool_call':
        print(json.dumps(rec, indent=2)); break
" | less
```

The `samples/` directory in this folder has one pre-rendered example per
task type for quick eyeballing.

---

## 14. Capturing fresh trajectories from the live runtime

The runtime auto-records every turn into the `trajectories` table by
default (unless `ELIZA_DISABLE_TRAJECTORY_LOGGING=1`). The training app
exposes them via HTTP:

| Method   | Path                              | Notes                                   |
|----------|-----------------------------------|-----------------------------------------|
| `GET`    | `/api/trajectories`               | list (pagination + filtering)           |
| `GET`    | `/api/trajectories/:id`           | full detail for one trajectory          |
| `GET`    | `/api/trajectories/stats`         | counts per task type + recent activity  |
| `GET`    | `/api/trajectories/config`        | logging toggles                         |
| `PUT`    | `/api/trajectories/config`        | enable/disable per-task logging         |
| `POST`   | `/api/trajectories/export`        | dump to JSONL (gated by privacy-filter) |
| `DELETE` | `/api/trajectories`               | drop the table                          |

Routes are wired in
`eliza/apps/app-training/src/routes/trajectory-routes.ts`. The export
goes through the same `privacy-filter.ts` that gates the nightly cron,
so the records are safe to inspect.

End-to-end live demo:

```bash
# 1. Boot Milady (API on :31337 by default).
cd /home/shaw/milady
bun run dev

# 2. In another terminal, find your agent id and a room.
curl -s http://localhost:31337/api/agents | jq '.[0].id'

# 3. Send a message that should trigger an action.
curl -s -X POST http://localhost:31337/api/messaging/<roomId>/messages \
  -H "Content-Type: application/json" \
  -d '{"text":"what time is it"}'

# 4. Pull the latest trajectories.
curl -s 'http://localhost:31337/api/trajectories?limit=5' | jq '.items[].taskType'

# 5. Inspect one in full (it has the same shape as a corpus record).
TID=$(curl -s 'http://localhost:31337/api/trajectories?limit=1' | jq -r '.items[0].id')
curl -s "http://localhost:31337/api/trajectories/$TID" | jq

# 6. Or dump everything to JSONL on disk via the export endpoint.
curl -s -X POST 'http://localhost:31337/api/trajectories/export' \
  -H "Content-Type: application/json" \
  -d '{"taskTypes":["agent_trace","reply","should_respond"]}' | jq

# Default archive directory is `~/.milady/trajectories/archive/` — files
# land as `<task>-<YYYYMMDDHHMMSS>.jsonl.gz`.
ls ~/.milady/trajectories/archive/ | tail -5
```

A trajectory pulled from the live API has the same seven top-level keys
defined in §2 — `roomName`, `agentId`, `memoryEntries`, `currentMessage`,
`expectedResponse`, `availableActions`, `metadata`. The runtime fills
them in directly from the prompt-build pipeline that drives the model
calls described in §1, so the on-disk corpus and freshly-collected
trajectories are interchangeable.
