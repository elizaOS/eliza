# Add ELIZA_UI_ENABLE environment variable to disable web UI in production

## Problem

ElizaOS currently serves the web UI to anyone who can reach the server. While there's `ELIZA_SERVER_AUTH_TOKEN` for API endpoints, the web interface itself (HTML, CSS, JS files) is completely open. In production deployments, this creates an unnecessary attack surface.

I'm probably being paranoid since this is my first proper PR, but it seems like production servers should be able to run API-only without exposing a web interface.

## Solution

Added `ELIZA_UI_ENABLE` environment variable with smart defaults:
- **Development**: UI enabled by default (unchanged developer experience)
- **Production**: UI disabled by default (secure by default)
- **Override**: Set `ELIZA_UI_ENABLE=true/false` to force enable/disable

When disabled, the web UI returns a clean 404 JSON response, but all API endpoints continue working normally.

## Implementation

Really minimal changes - just ~20 lines in `packages/server/src/index.ts`:

1. Check `NODE_ENV` and `ELIZA_UI_ENABLE` to determine UI status
2. Conditionally serve static files only when UI is enabled
3. Replace SPA fallback with 404 response when UI is disabled
4. Update startup logging to clearly show UI status

## Testing

```bash
# Development (UI enabled)
bun start

# Production (UI disabled)  
NODE_ENV=production bun start

# Force enable in production
NODE_ENV=production ELIZA_UI_ENABLE=true bun start

# Force disable in development
ELIZA_UI_ENABLE=false bun start
```

When UI is disabled:
- `http://localhost:3000` → `{"success":false,"error":{"message":"Web UI disabled","code":404}}`
- `http://localhost:3000/api/server/ping` → Still works fine

## Questions for the team

I don't know enough about the deployment patterns people use with ElizaOS to be sure this covers all use cases. Are there scenarios where this approach might cause issues?

Also, I kept the API authentication (`ELIZA_SERVER_AUTH_TOKEN`) completely separate from this UI disable feature. Should they be related somehow, or is it good that they're independent controls?

## Backward compatibility

Should be fully backward compatible - no breaking changes, development experience stays the same. Only affects deployments that explicitly set `NODE_ENV=production`.

---

Discord: @bealers 