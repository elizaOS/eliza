
![alt text](src/assets/hyperbolic.png)

# Hyperbolic Plugin
A powerful plugin for managing GPU instances on the Hyperbolic platform through Eliza AI.

## Features

- List available GPUs with specifications and pricing
- Check account balance
- Monitor GPU instance status
- View spending history
- Rent GPU instances
- Terminate GPU instances

## Actions

### 1. GET_HB_AVAILABLE_GPUS
Lists all available GPU machines on the Hyperbolic platform with their specifications and pricing.

**Example prompt:**
```
Show me available GPUs on Hyperbolic
```

### 2. GET_CURRENT_BALANCE
Checks your current balance on the Hyperbolic platform.

**Example prompt:**
```
Show my current balance on Hyperbolic
```

### 3. GET_GPU_STATUS
Monitors the status of all your GPU instances.

**Example prompt:**
```
Check status of all my GPU instances on Hyperbolic
```

### 4. GET_SPEND_HISTORY
Shows your spending history on the Hyperbolic platform.

**Example prompt:**
```
Show my spending history on Hyperbolic
```

### 5. RENT_HB_COMPUTE
Rents a GPU instance using node ID and cluster name.

**Example prompt:**
```
Create a GPU instance on the Hyperbolic
[nodeid]las1-prd-acl-msi-09.fen.intra[/nodeid]
[cluster]circular-snapdragon-worm[/cluster]
```

**Required format:**
- Node ID must be wrapped in `[nodeid]` tags
- Cluster name must be wrapped in `[cluster]` tags

### 6. TERMINATE_COMPUTE
Terminates a running GPU instance.

**Example prompts:**
```
Terminate the Hyperbolic instance [gpu]worse-walnut-viper[/gpu]
```
```
Terminate the Hyperbolic instance [gpu]puny-clover-basilisk[/gpu]
```

**Important Note:** When terminating an instance, you must provide the instance ID wrapped in `[gpu]` tags. The examples above show two different instance IDs (`worse-walnut-viper` and `puny-clover-basilisk`) to demonstrate the format.

## Configuration

The plugin requires the following environment variables:

```bash
HYPERBOLIC_API_KEY=your_api_key_here
HYPERBOLIC_ENV=production     # or development
HYPERBOLIC_GRANULAR_LOG=true  # optional, for detailed logging
HYPERBOLIC_LOG_LEVEL=debug    # optional, to control the level
HYPERBOLIC_SPASH=true         # to show the splash
```

## Response Format

All actions return structured responses with:
- Success/failure status
- Detailed error messages when applicable
- Formatted text output
- Additional data specific to each action

## Error Handling

The plugin includes comprehensive error handling for:
- Invalid API keys
- Network issues
- Invalid input formats
- API rate limits
- Server errors

## Logging

Granular logging is available by setting `HYPERBOLIC_GRANULAR_LOG=true`. This provides detailed information about:
- API requests and responses
- Validation steps
- Error details
- Action execution flow

## Development

To extend or modify this plugin:

1. All actions are in the `src/actions` directory
2. Utility functions are in `src/utils`
3. Environment configuration is in `src/environment.ts`
4. Error types are in `src/error/base.ts`

## Dependencies

- @elizaos/core
- axios
- chalk (for console output)
- cli-table3 (for formatted tables)
- ora (for loading spinners)

## License

MIT License
