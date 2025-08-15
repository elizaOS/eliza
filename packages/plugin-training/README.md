# ElizaOS Training Plugin

A training data extraction and custom reasoning plugin for ElizaOS agents with
support for fine-tuned models via Together.ai.

## Features

- 📊 **Training Data Extraction** - Extract conversation data from ElizaOS
  agents
- 🧠 **Dataset Building** - Prepare datasets in JSONL format for fine-tuning
- 🤗 **HuggingFace Integration** - Upload datasets to HuggingFace Hub
- 🤖 **Custom Reasoning** - MVP implementation for model override capabilities
- 🚀 **Together.ai Support** - Integration with Together.ai for model training

## Installation

```bash
# Install dependencies
npm install

# Build the plugin
npm run build
```

## Quick Start

### 1. Add to Your Agent

```typescript
import {
  trainingPlugin,
  mvpCustomReasoningPlugin,
} from '@elizaos/plugin-training';

const agent = {
  character: myCharacter,
  plugins: [
    '@elizaos/plugin-sql',
    trainingPlugin, // Full training features
    mvpCustomReasoningPlugin, // Simple custom reasoning (recommended)
  ],
};
```

### 2. Environment Configuration

```bash
# Optional - For HuggingFace dataset uploads
HUGGING_FACE_TOKEN=hf_...

# Optional - For Together.ai integration
TOGETHER_AI_API_KEY=...

# Optional - For custom reasoning
REASONING_SERVICE_ENABLED=true
REASONING_SERVICE_SHOULD_RESPOND_ENABLED=true
```

### 3. Use Agent Actions

```
"extract training data from the last 30 days"
"enable custom reasoning"
"check reasoning status"
```

## Available Scripts

### Core Scripts

```bash
npm test                # Run all tests
npm run test:unit       # Run unit tests only
npm run lint            # Check code quality
npm run lint:fix        # Fix linting issues
npm run clean           # Clean build artifacts
npm run typecheck       # TypeScript type checking
```

### CLI Commands

```bash
npm run cli:help        # Show CLI help
npm run cli:reasoning   # Custom reasoning commands
npm run cli:extract     # Extract training data
npm run cli:dataset     # Create datasets
npm run cli:train       # Train models
```

### Training Data Extraction

```bash
npm run extract:simple  # Simple data extraction
npm run extract:db      # Database extraction
```

### Dataset Management

```bash
npm run dataset:create  # Create JSONL datasets
npm run dataset:examples # List training examples
```

### Custom Reasoning

```bash
npm run reasoning:config   # Show reasoning config
npm run reasoning:models   # List model status
npm run reasoning:export   # Export training data
npm run reasoning:costs    # Show cost breakdown
```

### Model Training

```bash
npm run train:model     # Train a model
npm run train:simulate  # Simulate training
npm run train:test      # Test trained model
```

## Plugin Exports

### Main Plugin

```typescript
import { trainingPlugin } from '@elizaos/plugin-training';
// Full-featured plugin with all training capabilities
```

### MVP Custom Reasoning (Recommended)

```typescript
import { mvpCustomReasoningPlugin } from '@elizaos/plugin-training/mvp';
// Simple, working custom reasoning implementation
```

### Enhanced Custom Reasoning

```typescript
import { enhancedCustomReasoningPlugin } from '@elizaos/plugin-training/enhanced';
// Advanced features with database integration
```

## Actions

### EXTRACT_TRAINING_DATA

Extract conversation data for training datasets.

**Triggers:**

- "extract training data"
- "prepare dataset"
- "collect conversation data"

### START_TRAINING

Start training jobs with extracted data.

**Triggers:**

- "start training"
- "begin fine-tuning"
- "launch training job"

### MONITOR_TRAINING

Monitor training progress and status.

**Triggers:**

- "monitor training"
- "check training status"
- "training progress"

### Custom Reasoning Actions (MVP)

- **ENABLE_REASONING_SERVICE** - Enable custom reasoning
- **DISABLE_REASONING_SERVICE** - Disable custom reasoning
- **CHECK_REASONING_STATUS** - Check reasoning status

## Architecture

### Core Components

1. **TrainingService** - Main service for data extraction and training
2. **DataExtractor** - Extract conversation data from ElizaOS
3. **DatasetProcessor** - Process and format training datasets
4. **HuggingFaceClient** - Upload datasets to HuggingFace Hub
5. **TogetherAIClient** - Interface with Together.ai for training

### MVP Custom Reasoning

Simple service that can intercept and override model calls:

```typescript
// Enable custom reasoning
await runtime.processMessage({
  content: { text: 'enable custom reasoning' },
});

// The service will now intercept useModel calls
const response = await runtime.useModel('TEXT_LARGE', {
  prompt: 'Test prompt',
});
// This could be routed to a custom fine-tuned model
```

## Testing

The package includes comprehensive tests:

```bash
# Unit tests (fast, reliable)
npm run test:unit

# All tests (includes integration tests)
npm test
```

**Test Coverage:**

- ✅ Simple Integration Tests (5/5 passing)
- ✅ Complete Workflow Tests (5/5 passing)
- ✅ Enhanced Integration Tests (8/8 passing)
- ✅ HuggingFace Integration Tests (4/4 passing)

## Data Format

### Training Examples

```json
{
  "id": "example-123",
  "input": "User question or prompt",
  "output": "Agent response",
  "metadata": {
    "timestamp": "2024-01-01T00:00:00Z",
    "quality": 0.85,
    "tokens": 150
  }
}
```

### JSONL Dataset Format

```json
{"messages": [{"role": "user", "content": "Hello"}, {"role": "assistant", "content": "Hi there!"}]}
{"messages": [{"role": "user", "content": "Help me code"}, {"role": "assistant", "content": "I'd be happy to help!"}]}
```

## Development

### Project Structure

```
src/
├── actions/          # Agent actions
├── cli/             # Command-line interface
├── enhanced/        # Enhanced reasoning features
├── lib/             # Core libraries
├── mvp/             # MVP implementations
├── services/        # Core services
├── utils/           # Utility functions
└── __tests__/       # Test files
```

### Adding New Features

1. Create action in `src/actions/`
2. Add CLI command in `src/cli/commands/`
3. Write tests in `src/__tests__/`
4. Update exports in `src/index.ts`

## Troubleshooting

### Common Issues

**Build Errors**

```bash
npm run clean
npm run build
```

**Test Failures**

```bash
# Run specific test
npm run test:unit
```

**Lint Errors**

```bash
npm run lint:fix
```

**TypeScript Errors**

```bash
npm run typecheck
```

### Getting Help

- 📖 [ElizaOS Documentation](https://elizaos.ai/docs)
- 💬 [Discord Community](https://discord.gg/elizaos)
- 🐛 [GitHub Issues](https://github.com/elizaos/eliza/issues)

## License

MIT License - see [LICENSE](../../LICENSE) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new features
4. Ensure all tests pass: `npm test`
5. Check code quality: `npm run lint`
6. Submit a pull request

---

**Status**: Core functionality working, MVP custom reasoning available,
comprehensive test suite passing.
