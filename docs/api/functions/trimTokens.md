[@elizaos/core v0.25.8](../index.md) / trimTokens

# Function: trimTokens()

> **trimTokens**(`context`, `maxTokens`, `runtime`): `Promise`\<`string`\>

Trims the provided text context to a specified token limit using a tokenizer model and type.

The function dynamically determines the truncation method based on the tokenizer settings
provided by the runtime. If no tokenizer settings are defined, it defaults to using the
TikToken truncation method with the "gpt-4o" model.

## Parameters

• **context**: `string`

The text to be tokenized and trimmed.

• **maxTokens**: `number`

The maximum number of tokens allowed after truncation.

• **runtime**: [`IAgentRuntime`](../interfaces/IAgentRuntime.md)

The runtime interface providing tokenizer settings.

## Returns

`Promise`\<`string`\>

A promise that resolves to the trimmed text.

## Async

## Function

trimTokens

## Throws

Throws an error if the runtime settings are invalid or missing required fields.

## Example

```ts
const trimmedText = await trimTokens("This is an example text", 50, runtime);
console.log(trimmedText); // Output will be a truncated version of the input text.
```

## Defined in

[packages/core/src/generation.ts:101](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L101)
