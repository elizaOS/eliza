# Environment Variables

This document describes the server configuration environment variables for ElizaOS.

## Server Security & Authentication

### ELIZA_SERVER_AUTH_TOKEN

Controls API authentication for the ElizaOS server.

- **Purpose**: When set, requires all `/api/*` routes to include an `X-API-KEY` header with this token value
- **Default**: Unset (no authentication required)
- **Security**: When unset, all API endpoints are publicly accessible
- **Usage**:
  ```bash
  ELIZA_SERVER_AUTH_TOKEN=your-secret-token
  ```
- **Headers**: Clients must send `X-API-KEY: your-secret-token` header
- **Behavior**:
  - If unset: All requests allowed (no authentication)
  - If set: Only requests with matching `X-API-KEY` header allowed
  - Returns `401 Unauthorized` for invalid/missing keys

## Web UI Control

### ELIZA_UI_ENABLE

Controls whether the web user interface is served by the server.

- **Purpose**: Enable or disable the web UI for security and deployment flexibility
- **Values**:
  - `true` - Force enable UI
  - `false` - Force disable UI
  - Unset/empty - Automatic behavior (enabled in development, disabled in production)
- **Default Behavior**:
  - Development (`NODE_ENV=development`): UI enabled
  - Production (`NODE_ENV=production`): UI disabled for security
- **Usage**:
  ```bash
  # Force enable in production
  ELIZA_UI_ENABLE=true

  # Force disable in development
  ELIZA_UI_ENABLE=false

  # Use automatic behavior
  ELIZA_UI_ENABLE=
  ```
- **Security**: Disabling UI reduces attack surface by removing web interface
- **API Access**: API endpoints remain available regardless of UI setting

## Examples

### Production Deployment (Secure)
```bash
NODE_ENV=production
ELIZA_SERVER_AUTH_TOKEN=secure-random-token-here
ELIZA_UI_ENABLE=false
```

### Development Setup (Convenient)
```bash
NODE_ENV=development
# ELIZA_SERVER_AUTH_TOKEN=  # Unset for easy development
# ELIZA_UI_ENABLE=         # Unset for automatic behavior (UI enabled)
```

### Headless API Server
```bash
ELIZA_SERVER_AUTH_TOKEN=api-only-token
ELIZA_UI_ENABLE=false
```

## Related Files

- **Configuration**: `.env.example` - Template with all available environment variables
- **Authentication**: `packages/server/src/authMiddleware.ts` - API key validation logic
- **UI Control**: `packages/server/src/index.ts` - Web UI enable/disable logic
