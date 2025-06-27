# ElizaOS Web UI Disable Feature

## Overview

Added `ELIZA_UI_ENABLE` environment variable to control whether the web UI is served by the ElizaOS server. This addresses production security concerns by allowing complete disabling of the web interface while keeping API functionality intact.

## Implementation

### Changes Made

- **File Modified**: `packages/server/src/index.ts`
- **Lines Changed**: ~20 lines added
- **New Class Property**: `private uiEnabled: boolean`

### Logic

```typescript
// Determine if web UI should be enabled
const isProduction = process.env.NODE_ENV === 'production';
const uiEnabledEnv = process.env.ELIZA_UI_ENABLE;
this.uiEnabled = uiEnabledEnv !== undefined 
  ? uiEnabledEnv.toLowerCase() === 'true' 
  : !isProduction; // Default: enabled in dev, disabled in prod
```

### Behavior

| Environment | ELIZA_UI_ENABLE | UI Status | Use Case |
|-------------|-------------------|-----------|----------|
| development | (unset) | ✅ Enabled | Default dev experience |
| production | (unset) | ❌ Disabled | Secure production default |
| any | `true` | ✅ Enabled | Force enable override |
| any | `false` | ❌ Disabled | Force disable override |

## Usage

### Development (Default - UI Enabled)
```bash
bun start
# OR
NODE_ENV=development bun start
```

### Production (Default - UI Disabled)  
```bash
NODE_ENV=production bun start
```

### Force Enable UI
```bash
ELIZA_UI_ENABLE=true bun start
# OR
NODE_ENV=production ELIZA_UI_ENABLE=true bun start
```

### Force Disable UI
```bash
ELIZA_UI_ENABLE=false bun start
# OR 
NODE_ENV=development ELIZA_UI_ENABLE=false bun start
```

## Expected Behavior

### When UI is Enabled
- ✅ `http://localhost:3000` serves the web interface
- ✅ `http://localhost:3000/api/*` serves API endpoints
- ✅ Static files (CSS, JS, images) are served
- ✅ SPA routing works (serves index.html for client-side routes)

### When UI is Disabled
- ❌ `http://localhost:3000` returns `{"success":false,"error":{"message":"Web UI disabled","code":404}}`
- ✅ `http://localhost:3000/api/*` still works normally
- ❌ Static files return 404
- ❌ No HTML/CSS/JS served

## Logging

The server will clearly indicate UI status on startup:

**UI Enabled:**
```
INFO: Web UI enabled
Startup successful!
Go to the dashboard at http://localhost:3000
```

**UI Disabled:**
```  
INFO: Web UI disabled for security (production mode)
Startup successful!
API server running at http://localhost:3000/api (Web UI disabled)
```

## Security Benefits

1. **Attack Surface Reduction**: Completely eliminates web UI attack vectors in production
2. **Clear Intent**: Production defaults to secure mode
3. **Flexibility**: Can be overridden when needed
4. **API Preservation**: Backend functionality remains intact

## Testing

### Manual Testing Commands

```bash
# Test 1: Development default (should show UI)
bun start
curl http://localhost:3000  # Should return HTML

# Test 2: Production default (should block UI)  
NODE_ENV=production bun start
curl http://localhost:3000  # Should return {"success":false,...}

# Test 3: API still works when UI disabled
curl http://localhost:3000/api/server/ping  # Should work

# Test 4: Force enable in production
NODE_ENV=production ELIZA_UI_ENABLE=true bun start
curl http://localhost:3000  # Should return HTML
```

## Backward Compatibility

- ✅ **Fully backward compatible**
- ✅ **No breaking changes** 
- ✅ **Development experience unchanged**
- ✅ **Existing deployments unaffected** (unless they explicitly set NODE_ENV=production)

## Use Cases

1. **Production Security**: Deploy API-only servers without web interface exposure
2. **Microservice Architecture**: Run ElizaOS as a headless service
3. **Custom Frontends**: Disable built-in UI when using custom client applications
4. **Compliance**: Meet security requirements that prohibit web interfaces 