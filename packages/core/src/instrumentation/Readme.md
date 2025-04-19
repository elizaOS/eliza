# PostgreSQL Instrumentation

This document describes how PostgreSQL is used for instrumentation within the Eliza project.

## Setup

### 1. Start a PostgreSQL Instance

Run a dedicated PostgreSQL container for storing instrumentation data:

```bash
docker run -d --name postgres-tracing -p 5432:5432 \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=eliza_tracing \
  postgres:15
```

### 2. Configure Environment Variables

Set the following environment variables:

```bash
# Enable instrumentation
INSTRUMENTATION_ENABLED=true

# PostgreSQL connection string for instrumentation data
POSTGRES_URL_INSTRUMENTATION="postgresql://postgres:postgres@localhost:5432/eliza_tracing"
```

## Implementation

The Eliza core's `AgentRuntime` class and associated plugins use OpenTelemetry to trace key operations and store these traces in PostgreSQL. When instrumentation is enabled, the system:

1. Creates spans for important operations (agent initialization, model calls, action processing)
2. Records detailed attributes for these operations
3. Exports the resulting traces to the configured PostgreSQL database

The instrumentation is managed by the `InstrumentationService` class, which automatically handles the configuration based on the environment variables.
