[@elizaos/core v0.25.8](../index.md) / TelemetrySettings

# Type Alias: TelemetrySettings

> **TelemetrySettings**: `object`

## Type declaration

### isEnabled?

> `optional` **isEnabled**: `boolean`

Enable or disable telemetry. Disabled by default while experimental.

### recordInputs?

> `optional` **recordInputs**: `boolean`

Enable or disable input recording. Enabled by default.

You might want to disable input recording to avoid recording sensitive
information, to reduce data transfers, or to increase performance.

### recordOutputs?

> `optional` **recordOutputs**: `boolean`

Enable or disable output recording. Enabled by default.

You might want to disable output recording to avoid recording sensitive
information, to reduce data transfers, or to increase performance.

### functionId?

> `optional` **functionId**: `string`

Identifier for this function. Used to group telemetry data by function.

## Defined in

[packages/core/src/types.ts:689](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L689)
