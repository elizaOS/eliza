# elizaOS runtime phases — canonical training taxonomy

This document is the contract that **every training record must conform
to**. The runtime makes exactly four kinds of LLM calls per turn, each
tagged with a `purpose` value. The training corpus must cover all four.

The `purpose` values come straight from the runtime — see
`eliza/packages/core/src/trajectory-context.ts:17`:

> Pipeline stage purpose for trajectory logging (e.g. "should_respond",
> "response", "action", "evaluation").

If a training record cannot be classified into one of these four
purposes, it is teaching the model a behavior that the runtime never
exercises — i.e. it is at best dead weight, at worst noise that drifts
the model away from runtime behavior.

---

## Phase 1 — `should_respond` (the gate)

**When the runtime calls it:** before any reply, on every inbound message
that reached the bootstrap MESSAGE_RECEIVED handler. The runtime decides
whether to engage with the message at all.

**Where it lives:** `eliza/packages/core/src/services/message.ts:4565`
(`setTrajectoryPurpose("should_respond")`).

**Templates used:**

| Template                            | When                                                         |
|-------------------------------------|--------------------------------------------------------------|
| `shouldRespondTemplate`             | default gate                                                 |
| `shouldRespondWithContextTemplate`  | when context-routing is enabled (multi-domain agents)        |

Both live in `eliza/packages/core/src/prompts.ts:1039` /  `:1083`.

**Input shape (what the model sees):**

```
task: Decide whether {{agentName}} should respond, ignore, or stop.

context:
{{providers}}      # recent_messages, room_state, contact_directory, ...

available_contexts:
{{availableContexts}}  # e.g. wallet, support, default

rules[7]:
- direct mention of {{agentName}} -> RESPOND
- different assistant name or talking to someone else -> IGNORE unless
  {{agentName}} is also directly addressed
- ...

output:
TOON only.

Example:
name: {{agentName}}
reasoning: Direct mention and clear follow-up.
action: RESPOND
primaryContext: general
secondaryContexts:
evidenceTurnIds:
```

**Output shape (what the model must emit):**

```toon
name: <agent name>
reasoning: <one-line justification>
action: RESPOND | REPLY | IGNORE | STOP
speak_up: <0-100>             # only on shouldRespondWithContextTemplate
hold_back: <0-100>            # only on shouldRespondWithContextTemplate
primaryContext: <one of available_contexts, or "general">
secondaryContexts: <comma-separated, may be empty>
evidenceTurnIds: <comma-separated, may be empty>
```

`REPLY` and `RESPOND` both mean engage; `IGNORE` skips the turn; `STOP`
ends the run.

**Corpus task_types that map here:**

- `should_respond` (synthesized dialogue routing)
- `dialogue_routing` (synthesized)
- `multiparty_should_respond` (ishiki-labs multi-party dialogue)

---

## Phase 2 — `response` (the planner / messageHandler)

**When the runtime calls it:** after `should_respond` returns
`RESPOND`/`REPLY`. This is the main brain step: pick actions, write a
draft reply, decide which providers to call.

**Where it lives:** `eliza/packages/core/src/services/message.ts:5635`
(`setTrajectoryPurpose("response")`).

**Templates used:**

| Template                       | When                                                    |
|--------------------------------|---------------------------------------------------------|
| `messageHandlerTemplate`       | default planner (the one nubilio + agent-trove emit)    |
| `multiStepDecisionTemplate`    | autonomous task-mode multistep planning                 |
| `multiStepSummaryTemplate`     | last-step summary in autonomous mode                    |
| `messageClassifierTemplate`    | classifier-only routing variant                         |

All in `prompts.ts`.

**Input shape:**

```
task: Generate dialog and actions for {{agentName}}.

context:
{{providers}}     # recent_messages + any subscribed providers

rules[22]:
- think briefly, then respond
- always include a thought field, even for direct replies
- actions execute in listed order
- if replying without another grounded state/action query, REPLY goes first
- ...

control_actions:
- STOP means the task is done and the agent should end the run

fields[5]{name,meaning}:
- thought    | short plan
- actions    | ordered list of action entries, each with a name and optional params
- providers  | comma-separated provider names, or empty
- text       | next message for {{agentName}}
- simple     | true only when text itself should be sent directly as the
               final reply without running REPLY again

output:
TOON only.
```

**Output shape:**

```toon
thought: <short plan>
actions[N]:
  - name: <ACTION_NAME>
    params:
      <key>: <value>
providers[M]:
  - <providerName>
text: <user-facing message; empty when an action will produce the answer>
simple: true | false
```

Tool calls live INSIDE the actions list — there is no separate
"tool_calls" field. Builtin actions, plugin actions, and MCP tools all
dispatch through the `TASK_CALL` action with `params.tool` and
`params.arguments`:

```toon
actions[1]:
  - name: TASK_CALL
    params:
      tool: add_issue_comment
      arguments:
        owner: octocat
        repo: Spoon-Knife
        issue_number: 123
        body: "Resolved the review comment."
```

**Corpus task_types that map here:**

- `agent_trace` — full plan; this is the canonical shape
- `reply` — minimal plan (REPLY-only)
- `tool_call` — plan whose first action is `TASK_CALL`
- `mcp_tool_call` — same wire shape; tool comes from an MCP server
- `shell_command` — plan whose first action is `SHELL_COMMAND`
- `reasoning_cot` — plan with embedded reasoning trace
- `claude_distill` — plan distilled from a Claude teacher

---

## Phase 3 — `action` (each action.handler invocation)

**When the runtime calls it:** for each action in the plan emitted by
phase 2, the runtime calls `action.handler()`. Many actions are pure
side-effect (no LLM call), but several actions make their OWN LLM call
inside their handler — and those LLM calls are tagged
`purpose: "action"`.

**Where it lives:** `eliza/packages/core/src/runtime.ts:2583`
(`setTrajectoryPurpose("action")`), wrapping the loop at `:3070` that
calls `action.handler(...)`.

**Templates used (per action that does an LLM call):**

| Action                           | Template                                  |
|----------------------------------|-------------------------------------------|
| `REPLY`                          | `replyTemplate`                           |
| `ADD_CONTACT`                    | `addContactTemplate`                      |
| `REMOVE_CONTACT`                 | `removeContactTemplate`                   |
| `CHOOSE_OPTION`                  | `chooseOptionTemplate`                    |
| `EXTRACT_OPTION`                 | `optionExtractionTemplate`                |
| `EXTRACT_SECRETS`                | `extractSecretsTemplate`                  |
| `EXTRACT_SECRET_OPERATION`       | `extractSecretOperationTemplate`          |
| `EXTRACT_SECRET_REQUEST`         | `extractSecretRequestTemplate`            |
| `IMAGE_DESCRIPTION`              | `imageDescriptionTemplate`                |
| `IMAGE_GENERATION`               | `imageGenerationTemplate`                 |
| `POST_CREATION`                  | `postCreationTemplate`                    |
| `POST_ACTION_DECISION`           | `postActionDecisionTemplate`              |
| `AUTONOMY_*` (4 variants)        | `autonomy*Template`                       |
| Per-plugin actions               | their own templates                       |

**Input shape:** action-specific. A typical pattern is
`replyTemplate`-style:

```
# Task: Generate dialog for the character {{agentName}}.

About {{agentName}}:
{{bio}}

{{recentMessages}}

# Instructions: Write the next message for {{agentName}}.
- Use the action: REPLY
- Stay in character.
- ...
```

**Output shape:** action-specific. For `REPLY`'s template:

```toon
thought: <one-line plan>
text: <the actual user-facing reply>
```

For `EXTRACT_SECRETS`:

```toon
key: <name of secret>
value: <secret value extracted from message>
exists: true | false
```

For `CHOOSE_OPTION`:

```toon
option: <one of the offered choices>
reasoning: <why>
```

**Corpus task_types that map here:**

- The synthesized `synthesized/core_prompts/*.jsonl` set:
  - `add_contact.jsonl` — ADD_CONTACT action
  - `choose_option.jsonl` — CHOOSE_OPTION action
  - `extract_secrets.jsonl` — EXTRACT_SECRETS action
  - `multi_step_decision.jsonl` — multi-step planning
  - `message_classifier.jsonl` — classifier-only routing
  - `should_follow_room.jsonl` — room-routing (a should_respond cousin)

But there's a real gap: most of the corpus's `tool_call` /
`mcp_tool_call` / `shell_command` records describe the **plan that emits
the TASK_CALL action**, NOT the action handler's own LLM call. Those
records are phase 2 (response). We have very thin coverage of phase 3.

---

## Phase 4 — `evaluation` (post-turn evaluators)

**When the runtime calls it:** AFTER planned tool execution returns. The runtime
walks the registered `Evaluator[]` list, runs each evaluator's
`validate()` gate, and for those that pass it runs `evaluator.handler()`.
Each handler typically makes an LLM call to extract structured
information from the just-completed turn (facts, relationships,
reflections, summaries) and persists it to the appropriate stores
(`memory`, `relationships`, `facts`).

**Where it lives:** `eliza/packages/core/src/runtime.ts:3421`
(`setTrajectoryPurpose("evaluation")`), with the evaluator loop at
`:3450`.

**Templates used (one per evaluator):**

| Evaluator                  | Template                                      |
|----------------------------|-----------------------------------------------|
| `REFLECTION`               | `reflectionEvaluatorTemplate`                 |
| `REFLECT`                  | `reflectionTemplate`                          |
| `FACT_EXTRACTOR`           | `factExtractionTemplate`                      |
| `RELATIONSHIP_EXTRACTION`  | (uses reflectionEvaluatorTemplate)            |
| `SKILL_EXTRACTION`         | (advanced-capabilities)                       |
| `SKILL_REFINEMENT`         | (advanced-capabilities)                       |
| `LONG_TERM_EXTRACTION`     | `longTermExtractionTemplate`                  |
| `SUMMARIZATION`            | `initialSummarizationTemplate`                |

**Input shape:** evaluator-specific. Reflection looks like:

```
# Task: Generate Agent Reflection and Extract Relationships

# Recent Messages
{{recentMessages}}

# Existing Relationships
{{existingRelationships}}

# Existing Facts (already-known)
{{knownFacts}}

# Instructions
Generate:
1. A self-reflection on the last interaction
2. A list of new facts learned
3. A list of new relationships
```

**Output shape:** evaluator-specific. Reflection emits a JSON object:

```json
{
  "thought": "<reflection on the agent's behavior>",
  "facts": [
    {"claim": "...", "type": "fact", "in_bio": false, "already_known": false}
  ],
  "relationships": [
    {"sourceEntityId": "...", "targetEntityId": "...", "tags": [...]}
  ]
}
```

Fact extraction and summarization are smaller targeted shapes. See the
template definitions in `prompts.ts` for the exact fields each one
expects.

**Corpus task_types that map here:** **gap.** Only two synthesized
core_prompts files cover this surface:

- `synthesized/core_prompts/reflection.jsonl`
- `synthesized/core_prompts/reflection_evaluator.jsonl`

We have NO factExtraction examples, NO summarization examples, NO
relationshipExtraction, NO skill-extraction, NO long-term-memory
extraction. This is the largest gap in the corpus.

---

## Summary table

| Phase           | Purpose tag       | Runtime entry                         | Templates                                      | Corpus coverage |
|-----------------|-------------------|---------------------------------------|------------------------------------------------|-----------------|
| 1 should_respond| `should_respond`  | `services/message.ts:4565`            | shouldRespondTemplate (×2)                     | OK (synthesized)|
| 2 response      | `response`        | `services/message.ts:5635`            | messageHandlerTemplate, multiStepDecision/Summary, classifier | heavy (~80% of corpus) |
| 3 action        | `action`          | `runtime.ts:2583`, action.handler loop| replyTemplate + ~12 action-specific            | thin            |
| 4 evaluation    | `evaluation`      | `runtime.ts:3421`, evaluator loop     | reflection, factExtraction, summarization, relationship, skill, long-term-memory | gap            |

---

## What this means for synthesis + transformation

A training record that doesn't fit into one of these four phases is
training the model to do something the runtime never asks it to do. It
should be either reshaped to match one of the four buckets, or dropped.

For each phase, the synthesis spec is:

1. **`should_respond`**: input = recent messages + agentName + available
   contexts. Output = TOON with `name + reasoning + action +
   primaryContext + secondaryContexts + evidenceTurnIds`. Existing
   coverage is decent; expand multi-party variants.

2. **`response`**: input = `task: Generate dialog and actions for X` +
   providers. Output = TOON with `thought + actions + providers + text +
   simple`. **Tool calls are inside `actions`, not a separate field.**
   Existing nubilio + agent-trove + bitagent records are correct;
   enforce this shape during synthesis.

3. **`action`**: input + output are action-specific — see the template
   per action in `prompts.ts`. Synthesize one set per action that uses an
   LLM call. The current `synthesized/core_prompts/*.jsonl` covers ~6 of
   ~12 action templates.

4. **`evaluation`**: input = recent messages + existing
   facts/relationships/memory; output is a JSON object with extracted
   facts / relationships / reflections. Synthesize one set per evaluator
   (~7 evaluators). Currently only reflection has any data.

See `COVERAGE_AUDIT.md` for the full per-task_type classification of the
existing corpus and the concrete transform plan.
