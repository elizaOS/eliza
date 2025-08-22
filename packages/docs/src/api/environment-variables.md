# Environment Variables Documentation

## Overview

This document describes all environment variables used by the ElizaOS API server. Environment variables control various aspects of the server configuration, from security settings to performance tuning.

## Configuration File

Environment variables can be set in a `.env` file in the project root:

```bash
# Example .env file
PORT=3000
API_CORS_ORIGIN=https://api.example.com
EXPRESS_MAX_PAYLOAD=1mb
```

## Environment Variables Reference

### Server Configuration

#### `PORT`

- **Description**: The port number on which the server listens
- **Default**: `3000`
- **Type**: Number
- **Example**: `PORT=8080`

#### `HOST`

- **Description**: The host address to bind the server to
- **Default**: `0.0.0.0`
- **Type**: String
- **Example**: `HOST=localhost`

### CORS Configuration

#### `API_CORS_ORIGIN`

- **Description**: CORS origin specifically for API routes. More restrictive than general CORS settings.
- **Default**: Falls back to `CORS_ORIGIN` or `false` if neither is set
- **Type**: String | Boolean
- **Example**: `API_CORS_ORIGIN=https://api.example.com`
- **Notes**: Set to `*` to allow all origins (not recommended for production)

#### `CORS_ORIGIN`

- **Description**: General CORS origin for non-API routes
- **Default**: `false` (CORS disabled)
- **Type**: String | Boolean
- **Example**: `CORS_ORIGIN=https://example.com`

### Request Handling

#### `EXPRESS_MAX_PAYLOAD`

- **Description**: Maximum size of request payload (body) that the server will accept
- **Default**: `100kb`
- **Type**: String (with unit suffix)
- **Example**: `EXPRESS_MAX_PAYLOAD=10mb`
- **Valid Units**: `b`, `kb`, `mb`, `gb`
- **Notes**: Applies to JSON and URL-encoded bodies. Media uploads may have different limits.

### Application Information

#### `APP_VERSION`

- **Description**: Application version string returned in health check endpoints
- **Default**: `unknown`
- **Type**: String
- **Example**: `APP_VERSION=1.0.0`
- **Usage**: Returned in `/api/server/health` response

### Database Configuration

#### `DATABASE_URL`

- **Description**: PostgreSQL connection string
- **Default**: None (required for production)
- **Type**: String
- **Example**: `DATABASE_URL=postgresql://user:password@localhost:5432/eliza`

#### `DATABASE_POOL_MAX`

- **Description**: Maximum number of clients in the database pool
- **Default**: `20`
- **Type**: Number
- **Example**: `DATABASE_POOL_MAX=50`

### Logging Configuration

#### `LOG_LEVEL`

- **Description**: Minimum log level to output
- **Default**: `info`
- **Type**: String
- **Values**: `debug`, `info`, `warn`, `error`
- **Example**: `LOG_LEVEL=debug`

#### `LOG_FORMAT`

- **Description**: Log output format
- **Default**: `json`
- **Type**: String
- **Values**: `json`, `pretty`, `simple`
- **Example**: `LOG_FORMAT=pretty`

### Security Configuration

#### `NODE_ENV`

- **Description**: Node.js environment mode
- **Default**: `development`
- **Type**: String
- **Values**: `development`, `production`, `test`
- **Example**: `NODE_ENV=production`
- **Notes**: Affects security headers, error handling, and performance optimizations

#### `SESSION_SECRET`

- **Description**: Secret key for session encryption
- **Default**: Random generated string (not suitable for production)
- **Type**: String
- **Example**: `SESSION_SECRET=your-secret-key-here`
- **Notes**: Required for production deployments

#### `API_KEY_REQUIRED`

- **Description**: Whether API key authentication is required
- **Default**: `false`
- **Type**: Boolean
- **Example**: `API_KEY_REQUIRED=true`

### Rate Limiting

#### `RATE_LIMIT_WINDOW_MS`

- **Description**: Time window for rate limiting in milliseconds
- **Default**: `60000` (1 minute)
- **Type**: Number
- **Example**: `RATE_LIMIT_WINDOW_MS=900000` (15 minutes)

#### `RATE_LIMIT_MAX_REQUESTS`

- **Description**: Maximum number of requests per window
- **Default**: `60`
- **Type**: Number
- **Example**: `RATE_LIMIT_MAX_REQUESTS=100`

#### `RATE_LIMIT_SKIP_SUCCESSFUL_REQUESTS`

- **Description**: Whether to count only failed requests against the limit
- **Default**: `false`
- **Type**: Boolean
- **Example**: `RATE_LIMIT_SKIP_SUCCESSFUL_REQUESTS=true`

### File Upload Configuration

#### `UPLOAD_MAX_FILE_SIZE`

- **Description**: Maximum file size for uploads
- **Default**: `5mb`
- **Type**: String (with unit suffix)
- **Example**: `UPLOAD_MAX_FILE_SIZE=10mb`

#### `UPLOAD_ALLOWED_TYPES`

- **Description**: Comma-separated list of allowed MIME types
- **Default**: `image/jpeg,image/png,image/gif,image/webp,audio/mpeg,audio/wav,audio/ogg`
- **Type**: String
- **Example**: `UPLOAD_ALLOWED_TYPES=image/jpeg,image/png`

#### `UPLOAD_DIRECTORY`

- **Description**: Directory for storing uploaded files
- **Default**: `./uploads`
- **Type**: String (path)
- **Example**: `UPLOAD_DIRECTORY=/var/uploads`

### WebSocket Configuration

#### `WEBSOCKET_ENABLED`

- **Description**: Whether to enable WebSocket/Socket.IO support
- **Default**: `true`
- **Type**: Boolean
- **Example**: `WEBSOCKET_ENABLED=false`

#### `WEBSOCKET_PATH`

- **Description**: Path for Socket.IO endpoint
- **Default**: `/socket.io`
- **Type**: String
- **Example**: `WEBSOCKET_PATH=/ws`

#### `WEBSOCKET_PING_INTERVAL`

- **Description**: Interval between WebSocket ping messages (ms)
- **Default**: `25000`
- **Type**: Number
- **Example**: `WEBSOCKET_PING_INTERVAL=30000`

#### `WEBSOCKET_PING_TIMEOUT`

- **Description**: Time to wait for ping response before disconnecting (ms)
- **Default**: `60000`
- **Type**: Number
- **Example**: `WEBSOCKET_PING_TIMEOUT=90000`

### Performance Tuning

#### `WORKER_THREADS`

- **Description**: Number of worker threads for CPU-intensive tasks
- **Default**: Number of CPU cores
- **Type**: Number
- **Example**: `WORKER_THREADS=4`

#### `CACHE_TTL`

- **Description**: Default cache time-to-live in seconds
- **Default**: `300` (5 minutes)
- **Type**: Number
- **Example**: `CACHE_TTL=600`

## Environment-Specific Configurations

### Development Environment

```bash
# .env.development
NODE_ENV=development
LOG_LEVEL=debug
LOG_FORMAT=pretty
CORS_ORIGIN=http://localhost:3001
API_CORS_ORIGIN=http://localhost:3001
```

### Production Environment

```bash
# .env.production
NODE_ENV=production
LOG_LEVEL=info
LOG_FORMAT=json
CORS_ORIGIN=https://app.example.com
API_CORS_ORIGIN=https://api.example.com
SESSION_SECRET=your-secure-secret-here
API_KEY_REQUIRED=true
RATE_LIMIT_MAX_REQUESTS=100
```

### Testing Environment

```bash
# .env.test
NODE_ENV=test
LOG_LEVEL=error
DATABASE_URL=postgresql://test:test@localhost:5432/eliza_test
RATE_LIMIT_MAX_REQUESTS=1000
```

## Loading Environment Variables

### Using dotenv

```javascript
import dotenv from 'dotenv';

// Load default .env file
dotenv.config();

// Load environment-specific file
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
```

### Validation

```javascript
// Example validation function
function validateEnvironment() {
  const required = ['DATABASE_URL', 'SESSION_SECRET'];

  for (const varName of required) {
    if (!process.env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }
}
```

## Best Practices

1. **Never commit `.env` files** to version control
2. **Use `.env.example`** to document required variables
3. **Validate required variables** on startup
4. **Use strong secrets** in production
5. **Set appropriate CORS origins** for security
6. **Configure rate limits** based on your API usage
7. **Monitor and adjust** performance settings

## Troubleshooting

### Common Issues

1. **CORS errors**: Check `API_CORS_ORIGIN` and `CORS_ORIGIN` settings
2. **Large request errors**: Increase `EXPRESS_MAX_PAYLOAD`
3. **Database connection issues**: Verify `DATABASE_URL` format
4. **Rate limiting too strict**: Adjust `RATE_LIMIT_MAX_REQUESTS`
5. **File upload failures**: Check `UPLOAD_MAX_FILE_SIZE` and `UPLOAD_ALLOWED_TYPES`

### Debug Mode

Enable debug logging to troubleshoot issues:

```bash
LOG_LEVEL=debug
LOG_FORMAT=pretty
```

## Security Considerations

1. **Production Secrets**: Always use strong, unique secrets in production
2. **CORS Settings**: Be specific with allowed origins; avoid using `*`
3. **Rate Limiting**: Always enable rate limiting in production
4. **API Keys**: Enable `API_KEY_REQUIRED` for public-facing APIs
5. **File Uploads**: Restrict allowed file types and sizes
