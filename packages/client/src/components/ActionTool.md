# ActionTool Component

The `ActionTool` component integrates the [prompt-kit Tool component](https://www.prompt-kit.com/docs/tool) with ElizaOS action lifecycle messages, replacing the plain text action status messages (like "✅ Action GENERATE_IMAGE completed") with rich, interactive tool UI.

## How it works

1. **Action Detection**: The component detects action lifecycle messages by checking if the message has an `actionStatus` field
2. **Data Mapping**: Uses utility functions to map ElizaOS action data to the Tool component's expected format
3. **Rendering**: Replaces text-based action messages with interactive tool cards

## Data Flow

```
ElizaOS Runtime → rawMessage with actionStatus → API Client → UiMessage → ActionTool
```

### Raw Message Structure (from runtime)
```javascript
{
  "text": "✅ Action GENERATE_IMAGE completed",
  "runId": "uuid",
  "actions": ["GENERATE_IMAGE"],
  "actionId": "uuid", 
  "actionStatus": "completed", // Key field for detection
  "actionResult": { /* result data */ }
}
```

### Mapped UiMessage Structure
The `mapApiMessageToUi` function extracts action fields from `rawMessage`:
```typescript
{
  id: "message-uuid",
  text: "✅ Action GENERATE_IMAGE completed",
  actionStatus: "completed", // Extracted from rawMessage
  actionId: "uuid",
  actionResult: { /* result data */ },
  // ... other message fields
}
```

### Tool Component Format
The mapper transforms ElizaOS statuses to Tool component states:
- `executing` → `input-streaming`
- `completed` → `output-available` 
- `failed` → `output-error`
- `pending` → `input-available`

## Usage

The component is automatically used when rendering messages in the chat. No manual integration needed - it's integrated into the `MessageContent` component:

```tsx
// In MessageContent component
const isActionLifecycle = !!(message as any).actionStatus;

{isActionLifecycle ? (
  <ActionTool actionData={...} />
) : (
  // Regular message content
)}
```

## Components

- **`ActionTool`**: Main wrapper component for single actions
- **`ActionToolList`**: Renders multiple action tools (for future use)
- **`mapElizaActionToToolPart`**: Utility function for data transformation
- **`mapElizaStatusToToolState`**: Maps ElizaOS statuses to Tool states

## Files

- `src/components/ActionTool.tsx` - Main component
- `src/utils/action-mapper.ts` - Data mapping utilities  
- `src/lib/api-type-mappers.ts` - API message to UiMessage mapping
- `src/components/ui/tool.tsx` - prompt-kit Tool component
