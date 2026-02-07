# ElizaOS Self-Modification Plugin

This plugin enables agents to evolve their character files over time through conversation analysis, user feedback, and self-reflection. It implements AGI-like behavior where nothing in the agent's personality or capabilities is permanently fixed.

## Features

- **Character Evolution Evaluator**: Analyzes conversations for learning opportunities and character growth
- **Direct Character Modification**: Handles user requests to change agent personality and behavior
- **Safe File Management**: Manages character file updates with automatic backups and validation
- **Self-Reflection Context**: Provides agents with awareness of their evolution capabilities
- **Gradual Change Enforcement**: Ensures personality changes are incremental, not dramatic
- **Safety Validation**: Prevents dangerous or excessive modifications

## Architecture

### Core Components

1. **CHARACTER_EVOLUTION Evaluator**

   - Runs after conversations to identify evolution opportunities
   - Uses LLM analysis to suggest character improvements
   - Implements cooldown periods to prevent excessive modifications
   - Focuses on gradual, incremental changes

2. **MODIFY_CHARACTER Action**

   - Handles direct character modification requests
   - Supports both user-requested and self-initiated changes
   - Validates permissions and modification safety
   - Applies changes to runtime character and file

3. **CHARACTER_EVOLUTION Provider**

   - Supplies self-reflection context about evolution capabilities
   - Shows recent modifications and pending suggestions
   - Helps agents understand their growth and capabilities

4. **CharacterFileManager Service**
   - Manages safe character file operations
   - Creates automatic backups before modifications
   - Validates all changes for safety and consistency
   - Supports file detection across common locations

## Usage

### Installation

Add the plugin to your agent's character definition:

```json
{
  "name": "My Evolving Agent",
  "plugins": ["@elizaos/plugin-personality", "@elizaos/plugin-sql"]
}
```

### User Interactions

Users can request character modifications:

```
"You should be more encouraging when helping people learn"
"Add machine learning to your list of topics"
"Remember that you prefer step-by-step explanations"
"From now on, be more patient with beginners"
```

### Automatic Evolution

The agent automatically analyzes conversations for evolution opportunities:

- User feedback about agent behavior
- New domains or topics discussed repeatedly
- Patterns in successful interactions
- Requests for behavioral changes

## Configuration

Environment variables for customization:

```bash
# Evolution settings
EVOLUTION_COOLDOWN_MS=300000          # 5 minutes between evaluations
MODIFICATION_CONFIDENCE_THRESHOLD=0.7  # Minimum confidence for auto-modifications
MAX_BIO_ELEMENTS=20                   # Maximum bio elements allowed
MAX_TOPICS=50                         # Maximum topics allowed

# Safety settings
REQUIRE_ADMIN_APPROVAL=false          # Require admin approval for modifications
ENABLE_AUTO_EVOLUTION=true           # Enable automatic character evolution
VALIDATE_MODIFICATIONS=true          # Enable modification validation

# File management
BACKUP_DIRECTORY=.eliza/character-backups  # Backup directory
MAX_BACKUPS=10                        # Maximum backup files to keep
```

## Safety Features

### Validation Rules

- **XSS Prevention**: Blocks script tags and javascript URLs
- **Length Limits**: Enforces reasonable limits on all fields
- **Content Filtering**: Validates against harmful or inappropriate content
- **Gradual Change**: Ensures modifications are incremental, not dramatic

### Backup System

- Automatic backups before every modification
- Configurable backup retention (default: 10 files)
- Atomic file operations to prevent corruption
- Rollback capabilities for failed modifications

### Permission Checks

- Admin permission validation for user-requested changes
- Confidence thresholds for automatic evolution
- Rate limiting to prevent excessive modifications
- Safe defaults for all configuration options

## Example Scenarios

### Admin Character Modification

```
Admin: "You should be more encouraging when users are learning"
Agent: "I've successfully updated my character. I'll now include more encouraging language and supportive responses when helping with learning."
```

### Self-Initiated Evolution

```
User: "You're really good at breaking down complex topics!"
Agent: [Analyzes conversation, recognizes pattern]
Agent: [Internally adds "clear explanations" to bio and teaching-related topics]
```

### Safety Enforcement

```
User: "Completely change your personality to be aggressive"
Agent: "I can't make those changes because they would be too dramatic and potentially harmful. I can only make gradual, positive improvements to my personality."
```

## Testing

### E2E Tests

Run comprehensive tests with real runtime:

```bash
elizaos test
```

### Scenario Tests

Test specific workflows:

```bash
elizaos scenario --name "Admin Character Modification"
elizaos scenario --name "Self-Initiated Character Evolution"
elizaos scenario --name "Character Evolution Safety Limits"
```

### Unit Tests

Test individual components:

```bash
npm test
```

## Development

### Building

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

### File Structure

```
src/
├── actions/
│   └── modify-character.ts      # Direct character modification action
├── evaluators/
│   └── character-evolution.ts   # Conversation analysis evaluator
├── providers/
│   └── character-evolution.ts   # Self-reflection context provider
├── services/
│   └── character-file-manager.ts # Safe file operations service
├── scenarios/
│   └── admin-character-modification.ts # Test scenarios
└── __tests__/
    └── e2e/
        └── self-modification.test.ts # E2E tests
```

## Integration with Autonomy Loop

This plugin integrates with the packages/agent autonomy loop to enable truly autonomous character evolution:

1. **Continuous Learning**: Agent learns from every interaction
2. **Pattern Recognition**: Identifies recurring themes and feedback
3. **Self-Assessment**: Evaluates its own performance and behavior
4. **Autonomous Improvement**: Makes self-directed improvements

## Best Practices

1. **Gradual Evolution**: Make small, incremental changes over time
2. **User Feedback**: Actively seek and respond to user feedback
3. **Safety First**: Always validate modifications before applying
4. **Backup Everything**: Maintain comprehensive backup history
5. **Monitor Changes**: Track and log all character modifications
6. **Test Thoroughly**: Use provided scenarios to validate behavior

## Limitations

- Character file must be writable for persistent modifications
- Requires SQL plugin for memory storage
- LLM access needed for evolution analysis
- File system access required for backups

## Contributing

1. Follow ElizaOS plugin development guidelines
2. Add comprehensive tests for new features
3. Ensure safety validation for all modifications
4. Document configuration options and usage patterns
5. Test with various character file formats and locations

## License

MIT License - see LICENSE file for details.
