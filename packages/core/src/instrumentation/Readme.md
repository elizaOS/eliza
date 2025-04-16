# Eliza Agent Core Instrumentation

This document details the OpenTelemetry instrumentation implemented within the `AgentRuntime` class (`packages/core/src/runtime.ts`) of the Eliza Agent Core.

## Overview

The `AgentRuntime` utilizes OpenTelemetry for tracing key operations and interactions. This allows developers and operators to monitor the performance and behavior of agents, diagnose issues, and understand the flow of execution.

Instrumentation is provided via the `InstrumentationService` class, which wraps the OpenTelemetry SDK setup.

## Enabling/Disabling Instrumentation

Instrumentation can be enabled or disabled globally using the `INSTRUMENTATION_ENABLED` environment variable. Set it to `true` to enable tracing.

```bash
export INSTRUMENTATION_ENABLED=true
```

If disabled, the instrumentation methods become no-ops, minimizing performance overhead.

## Instrumented Operations

The following methods and operations within `AgentRuntime` are instrumented with spans:

*   **Initialization & Setup:**
    *   `constructor`: Basic initialization of the `InstrumentationService`.
    *   `initialize`: The main agent initialization process, including plugin registration, database checks, entity/room creation, and knowledge processing.
    *   `registerPlugin`: Each plugin registration, including initialization (`plugin.init`) and registration of its components (actions, evaluators, etc.).
    *   `registerService`: Registration and startup of individual services.
*   **Core Agent Logic:**
    *   `processActions`: The overall processing of actions triggered by a message.
        *   `Action.<action_name>`: Each individual action handler execution is wrapped in its own nested span.
    *   `evaluate`: The evaluation phase after a potential response, including evaluator selection and execution.
    *   `composeState`: The process of gathering context from providers.
        *   `provider.<provider_name>`: Each individual context provider (`provider.get`) execution is wrapped in its own nested span.
    *   `useModel`: Calls to underlying language or embedding models. Spans are named `AgentRuntime.useModel.<model_type>` (e.g., `AgentRuntime.useModel.TEXT_COMPLETION`).
    *   `emitEvent`: Specifically instruments the handling of the `EventType.MESSAGE_RECEIVED` event under the span name `AgentRuntime.handleMessageEvent`.
*   **Knowledge & Memory:**
    *   `addKnowledge`: Adding new knowledge items, including chunking, embedding, and storing fragments.
    *   `getKnowledge`: Retrieving relevant knowledge fragments based on a message.
*   **Database & State:**
    *   Instrumentation for direct database interactions (`getMemories`, `createMemory`, etc.) is primarily handled by the underlying PostgreSQL database adapter plugin (`@elizaos/plugin-sql`), though the high-level `AgentRuntime` methods might be called within other instrumented spans.
*   **Lifecycle:**
    *   `stop`: The process of stopping agent services.

## Key Span Attributes

Spans emitted by `AgentRuntime` include various attributes to provide context. Common attributes include:

*   `agent.id`: The UUID of the agent instance.
*   `agent.name`: The name of the agent character.
*   `plugin.name`: The name of the plugin being processed.
*   `action.name`: The name of the action being executed.
*   `provider.name`: The name of the context provider being executed.
*   `llm.request.model`: The type/key of the model being invoked (semantic convention).
*   `llm.duration_ms`: Duration of the model call.
*   `llm.usage.*_tokens`: Token usage (if available from the model response).
*   `message.id`: The ID of the message being processed.
*   `room.id`: The ID of the room associated with the event/message.
*   `context.sources.*`: Attributes detailing which context providers were used during `composeState`.
*   `error.*`: Attributes added when errors occur (e.g., `error.message`).

## Viewing Traces

The generated traces can be exported to various backends compatible with OpenTelemetry (e.g., Jaeger, Zipkin, Datadog, Honeycomb) by configuring an appropriate OpenTelemetry exporter. The specific configuration depends on the chosen backend and deployment environment.

## Notes

*   The level of detail (e.g., logging full parameters or responses) might vary based on verbosity settings or future refinements.
*   Error handling within instrumented functions aims to record exceptions and set the span status appropriately.
*   Instrumentation for database operations, external API calls within plugins, etc., might depend on the instrumentation within those specific plugins or libraries.

## Instrumented Plugins

While the core `AgentRuntime` provides the main instrumentation points, individual plugins might add their own specific spans. Refer to the documentation of each plugin for details.

### @elizaos/plugin-openai

*   **Location:** `packages/plugin-openai`
*   **Description:** This plugin instruments calls made to the OpenAI API for various models (text generation, embeddings, image generation, transcription). Spans typically include attributes like `llm.request.model`, token counts, and duration.