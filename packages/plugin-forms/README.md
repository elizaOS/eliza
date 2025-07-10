# ElizaOS Forms Plugin

A powerful forms management plugin for ElizaOS that enables structured data
collection through conversational interactions. This plugin allows agents to
create, manage, and process multi-step forms while maintaining natural
conversation flow.

## Features

- **Multi-Step Forms**: Create complex forms with multiple steps and conditional
  logic
- **Natural Language Processing**: Extract form values from user messages using
  LLM
- **Secret Field Handling**: Secure handling of sensitive data like API keys
- **Form Templates**: Pre-built templates for common use cases
- **Validation**: Field-level validation with custom criteria
- **Callbacks**: Step and form completion callbacks for extensibility
- **Provider Context**: Real-time form state information for agents

## Installation

```bash
npm install @elizaos/plugin-forms
```

## Usage

### Adding to Your Agent

```typescript
import { formsPlugin } from '@elizaos/plugin-forms';

// In your character configuration
{
  plugins: [formsPlugin],
  // ... other configuration
}
```

### Basic Example

```typescript
// User: "I need to fill out a contact form"
// Agent: "I've created a new contact form for you. Let's start with Basic Information.
//         Please provide the following information:
//         - Name: Your full name
//         - Email: Your email address"

// User: "My name is John Doe"
// Agent: "Updated form with: name
//         Still needed:
//         - Email (email): Your email address"

// User: "john@example.com"
// Agent: "Form completed successfully!"
```

## API Reference

### FormsService

The core service that manages form lifecycle.

#### Methods

- `createForm(templateOrDefinition)`: Create a new form
- `updateForm(formId, message)`: Update form with user input
- `listForms(status?)`: List forms by status
- `getForm(formId)`: Get a specific form
- `cancelForm(formId)`: Cancel an active form
- `registerTemplate(template)`: Register a custom template

### Form Templates

#### Built-in Templates

- **contact**: Basic contact information form

#### Creating Custom Templates

```typescript
const customTemplate: FormTemplate = {
  name: 'feedback',
  description: 'Customer feedback form',
  steps: [
    {
      id: 'rating',
      name: 'Overall Rating',
      fields: [
        {
          id: 'rating',
          label: 'Rating',
          type: 'number',
          description: 'Rate your experience from 1-5',
          criteria: 'Number between 1 and 5',
        },
        {
          id: 'comments',
          label: 'Comments',
          type: 'textarea',
          description: 'Additional comments',
          optional: true,
        },
      ],
    },
  ],
};

// Register the template
formsService.registerTemplate(customTemplate);
```

### Field Types

- `text`: Single line text input
- `textarea`: Multi-line text input
- `number`: Numeric input
- `email`: Email address
- `choice`: Selection from predefined options
- `checkbox`: Boolean value
- `date`: Date input

### Secret Fields

Mark fields as secret to handle sensitive data:

```typescript
{
  id: 'apiKey',
  label: 'API Key',
  type: 'text',
  secret: true, // Value will be masked in provider output
}
```

### Callbacks

Add callbacks to steps or forms for custom logic:

```typescript
{
  steps: [
    {
      id: 'step1',
      name: 'Step 1',
      fields: [...],
      onComplete: async (form, stepId) => {
        // Custom logic when step completes
        console.log(`Step ${stepId} completed`);
      },
    },
  ],
  onComplete: async (form) => {
    // Custom logic when entire form completes
    console.log('Form completed:', form.id);
  },
}
```

## Actions

### CREATE_FORM

Creates a new form from a template or custom definition.

**Triggers**: "create form", "fill out", "questionnaire", "survey", "contact",
"application"

### UPDATE_FORM

Updates the active form with user-provided values.

**Triggers**: Automatically validates when there's an active form

### CANCEL_FORM

Cancels the currently active form.

**Triggers**: "cancel", "stop", "abort", "quit", "exit", "nevermind"

## Provider

The forms provider (`FORMS_CONTEXT`) supplies information about active forms to
the agent, including:

- Current form status
- Required and optional fields
- Completed fields (with secret masking)
- Progress information

## Testing

The forms plugin includes comprehensive unit and integration tests.

```bash
# Run all tests (unit + E2E)
bun test

# Run only unit tests
bun run test:unit

# Run E2E tests directly (bypasses CLI test runner issues)
bun run test:e2e

# Run with coverage
bun test --coverage
```

### Test Coverage

The plugin maintains ~85% test coverage with tests for:

- Service initialization and lifecycle
- Form creation, updates, and cancellation
- Multi-step form progression
- Secret field handling
- Provider context generation
- Action validation and execution
- Template management

### Known Issues

The `elizaos test` command may encounter a pino logger compatibility issue. Use
`bun run test:e2e` to run the E2E tests directly.

## Integration with Other Plugins

The forms plugin can be used by other plugins to collect structured data. For
example:

```typescript
// In another plugin
const formsService = runtime.getService<FormsService>('forms');

// Create a custom form
const form = await formsService.createForm({
  name: 'api-config',
  steps: [
    {
      id: 'credentials',
      name: 'API Configuration',
      fields: [
        {
          id: 'apiKey',
          label: 'API Key',
          type: 'text',
          secret: true,
        },
        {
          id: 'endpoint',
          label: 'API Endpoint',
          type: 'text',
        },
      ],
      onComplete: async (form) => {
        // Save configuration
        const apiKey = form.steps[0].fields[0].value;
        const endpoint = form.steps[0].fields[1].value;
        // ... save to configuration
      },
    },
  ],
});
```

## Contributing

Contributions are welcome! Please ensure all tests pass and maintain the
existing code style.

## License

MIT
