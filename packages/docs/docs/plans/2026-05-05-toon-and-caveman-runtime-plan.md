# TOON + Caveman Runtime Plan

Date: 2026-05-05

## Policy

All model-facing structured action, evaluator, planner, and should-respond prompts should use TOON for instructions, examples, and expected output. The runtime may keep JSON objects internally, but model prompt transport should be TOON unless the requested artifact or external protocol is itself JSON/XML, such as n8n workflow JSON, HTTP payload JSON, TwiML/XML, package manifests, or provider SDK object generation.

Providers should return either plain task-oriented text or TOON-formatted context. Provider `data` may stay structured for code, but `text` included in prompts should not be XML/JSON unless domain-specific.

Every action and provider needs a compressed description. Existing code uses `descriptionCompressed`; support for the requested `compressedDescription` alias should be compatible, with planner rendering preferring the compressed value. Compression should be deterministic, caveman-style, and conservative: remove filler while preserving identifiers, code terms, paths, commands, URLs, dates, numbers, and domain terms.

## Research Summary

TOON is a line-oriented, indentation-based encoding of the JSON data model. It is designed as a translation layer: keep JSON in code, encode TOON for LLM prompt input/output, and decode back to JSON internally. It is strongest for uniform arrays because lengths and field lists are declared once.

Caveman compression is semantic prose compression. It should preserve technical tokens and structure while removing predictable grammar and filler.

## Current Findings

- `dynamicPromptExecFromState` already supports TOON parsing and TOON examples, but currently routes nested schemas to JSON and central planner calls still force XML.
- `messageHandlerTemplate` already asks for TOON, but `runSingleShotCore` wraps it with XML output instructions.
- `shouldRespond` already uses `preferredEncapsulation: "toon"` and TOON prompt text.
- `processActions` consumes parsed planner output and action params, with TOON param parsing already present.
- Streaming is the main migration risk: existing validation streaming extracts XML tags. TOON planner output must not stream `thought:`, `actions:`, or other control fields to users.
- Core and plugin code still contains many model-facing `Return JSON`, `Return XML`, and `<response>` prompt fragments.
- Actions get `descriptionCompressed` fallback through `withCanonicalActionDocs`; providers do not have equivalent runtime normalization today.

## Workstreams

1. Core structured output and planner
   - Make TOON the default in `dynamicPromptExecFromState`, including nested schemas.
   - Switch central planner, continuation, provider rescue, knowledge-provider decision, and repair prompts to TOON.
   - Add TOON-safe streaming for `text`, or disable planner streaming until parsed text is safe.

2. Core feature prompts
   - Convert core feature action/evaluator prompts from XML/JSON output instructions to TOON.
   - Keep domain-specific JSON/XML exceptions explicit.
   - Leave parser fallback compatibility intact.

3. Plugin prompts and providers
   - Convert plugin action/evaluator extraction prompts to TOON.
   - Convert provider `text` context to TOON/plain text.
   - Preserve domain exceptions such as n8n workflow JSON and TwiML/XML.

4. Compression enforcement and audit
   - Support `compressedDescription` and `descriptionCompressed` without breaking existing plugins.
   - Ensure planner/provider lists render compressed descriptions.
   - Add deterministic caveman-style compression fallback.
   - Add a compliance script/test for missing compressed descriptions and disallowed XML/JSON prompt text.

## Acceptance Checks

- Central planner prompt assembly no longer contains `Return only XML`, `<response>`, or JSON-only output instructions for generic action planning.
- `shouldRespond`, planner response, continuation, canonical action repair, provider rescue, and parameter repair all request TOON output.
- A streamed planner reply only emits user-facing `text`, not TOON control fields.
- Registered actions and providers have compressed descriptions after normalization.
- Remaining `Return JSON` / `Return XML` occurrences are either parser compatibility, tests/fixtures, or explicit domain-format exceptions.
- Targeted tests pass for structured output parsing, action planning, and streaming.
