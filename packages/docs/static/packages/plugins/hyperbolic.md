# Hyperbolic Plugin

## Purpose

A powerful plugin for managing GPU instances on the Hyperbolic platform through Eliza AI.

## Key Features

- List available GPUs with specifications and pricing
- Check account balance
- Monitor GPU instance status
- View spending history
- Rent GPU instances
- Terminate GPU instances

## Configuration

The plugin requires environment variables:

```bash
HYPERBOLIC_API_KEY=your_api_key_here
HYPERBOLIC_ENV=production     # or development
HYPERBOLIC_GRANULAR_LOG=true  # optional, for detailed logging
HYPERBOLIC_LOG_LEVEL=debug    # optional, to control the level
HYPERBOLIC_SPASH=true         # to show the splash
```

## Integration

Operates as a plugin for Eliza AI to manage GPU instances on the Hyperbolic platform.

## Example Usage

```
Show me available GPUs on Hyperbolic
Show my current balance on Hyperbolic
Check status of all my GPU instances on Hyperbolic
Show my spending history on Hyperbolic
Create a GPU instance on the Hyperbolic
[nodeid]las1-prd-acl-msi-09.fen.intra[/nodeid]
[cluster]circular-snapdragon-worm[/cluster]
Terminate the Hyperbolic instance [gpu]worse-walnut-viper[/gpu]
```
