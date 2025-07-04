
# Logging & Monitoring Guide

Monitor and analyze your ElizaOS agent's performance using the built-in logging system and optional third-party integrations. This guide covers logging configuration, monitoring tools, and performance tracking.

## 🎯 What Is ElizaOS Logging?

ElizaOS includes a comprehensive logging system built on Pino, providing structured logs, multiple output formats, and integration with error tracking services like Sentry.

### Logging Features

- 📊 **Structured Logging** - JSON-formatted logs for easy parsing
- 🎨 **Pretty Printing** - Human-readable console output
- 📝 **Multiple Log Levels** - From fatal errors to trace debugging
- 💾 **In-Memory Buffer** - Access recent logs programmatically
- 🚨 **Error Tracking** - Sentry integration for production monitoring
- ⚡ **High Performance** - Minimal overhead with async logging

## 🚀 Quick Start Guide

### Step 1: Configure Log Level

```bash
# Set in .env file
LOG_LEVEL=info  # Options: fatal, error, warn, info, debug, trace

# Or set via environment variable
LOG_LEVEL=debug elizaos start
```

### Step 2: Choose Log Format

```bash
# Pretty format for development (default)
LOG_FORMAT=pretty

# JSON format for production/parsing
LOG_FORMAT=json
```

### Step 3: View Logs

```bash
# Start your agent and view logs
elizaos start

# Logs appear in console with timestamp, level, and message
[2024-01-15 10:23:45] INFO: Agent started successfully
[2024-01-15 10:23:46] DEBUG: Loading character file
[2024-01-15 10:23:47] INFO: Connected to Discord
```

## 📊 Log Levels Explained

### Fatal
Critical errors that cause the application to exit:
```typescript
logger.fatal("Database connection failed", { error });
```

### Error
Errors that need attention but don't crash the app:
```typescript
logger.error("Failed to send message", { userId, error });
```

### Warn
Warning conditions that might cause problems:
```typescript
logger.warn("API rate limit approaching", { remaining: 10 });
```

### Info
General informational messages:
```typescript
logger.info("User joined channel", { userId, channel });
```

### Debug
Detailed information for debugging:
```typescript
logger.debug("Processing message", { content, metadata });
```

### Trace
Very detailed tracing information:
```typescript
logger.trace("Entering function", { args });
```

## 🛠️ Logging Configuration

### Basic Configuration

```typescript
// Access logger in your code
import { logger } from "@elizaos/core";

// Log with context
logger.info("Processing request", {
  userId: "123",
  action: "chat",
  platform: "discord"
});
```

### Custom Log Levels

ElizaOS adds custom levels for specific events:

```typescript
// Success events (appears in green)
logger.success("Character loaded successfully");

// Progress tracking (with spinner in console)
logger.progress("Loading plugins...");
```

### In-Memory Log Access

```typescript
// Access recent logs programmatically
const recentLogs = logger.getRecentLogs({
  count: 100,        // Number of logs to retrieve
  level: "error",    // Filter by level
  filter: "discord"  // Search in messages
});
```

## 🚨 Error Tracking with Sentry

### Setup Sentry Integration

```bash
# Add to .env
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx

# Optional: Environment tagging
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=1.0.0
```

### What Gets Tracked

- Uncaught exceptions
- Promise rejections  
- Error and fatal log levels
- Custom error events
- Performance metrics

### Sentry Dashboard Features

- Real-time error alerts
- Error grouping and trends
- User impact analysis
- Performance monitoring
- Release tracking

## 📈 Performance Monitoring

### Built-in Metrics

ElizaOS tracks key performance indicators:

```typescript
// Response time tracking
const start = Date.now();
// ... process request ...
logger.info("Request completed", {
  duration: Date.now() - start,
  action: "chat_response"
});
```

### Memory Usage

Monitor memory consumption:

```bash
# Enable memory debugging
DEBUG_MEMORY=true elizaos start

# Logs will include memory stats
[INFO] Memory usage: 245MB (RSS), 187MB (Heap)
```

### Platform-Specific Metrics

**Discord:**
- Message processing time
- Gateway latency
- API response times
- Cache hit rates

**Telegram:**
- Webhook processing time
- API call duration
- Message queue length

## 📋 Log Analysis Tools

### Using grep for Quick Searches

```bash
# Find all errors
elizaos start | grep ERROR

# Find specific user interactions
elizaos start | grep "userId:123"

# Count warnings
elizaos start | grep WARN | wc -l
```

### JSON Log Processing

When using JSON format:

```bash
# Parse with jq
elizaos start | jq 'select(.level >= 40)'

# Extract specific fields
elizaos start | jq '{time, level, msg}'

# Filter by context
elizaos start | jq 'select(.platform == "discord")'
```

### Log Aggregation

For production environments:

1. **File Output:**
```bash
# Redirect logs to file
elizaos start > agent.log 2>&1

# Rotate logs with logrotate
# /etc/logrotate.d/elizaos
/var/log/elizaos/*.log {
    daily
    rotate 7
    compress
    missingok
}
```

2. **External Services:**
- Elasticsearch + Kibana
- Splunk
- DataDog
- CloudWatch (AWS)

## 🎯 Monitoring Best Practices

### Development

```bash
# Verbose logging for debugging
LOG_LEVEL=debug LOG_FORMAT=pretty elizaos dev

# Filter specific modules
DEBUG=elizaos:* elizaos start
```

### Production

```bash
# Optimized for performance and parsing
LOG_LEVEL=info LOG_FORMAT=json elizaos start

# With error tracking
SENTRY_DSN=xxx LOG_LEVEL=warn elizaos start
```

### Key Metrics to Monitor

1. **Response Times**
   - Average response time
   - 95th percentile latency
   - Timeout rates

2. **Error Rates**
   - Errors per minute
   - Error types distribution
   - Failed API calls

3. **Usage Patterns**
   - Messages per hour
   - Active users
   - Platform distribution

4. **System Health**
   - Memory usage
   - CPU utilization
   - Database connections

## 🔍 Debugging Common Issues

### High Memory Usage

```typescript
// Add memory profiling
if (process.env.DEBUG_MEMORY) {
  setInterval(() => {
    const usage = process.memoryUsage();
    logger.info("Memory snapshot", {
      rss: Math.round(usage.rss / 1024 / 1024),
      heap: Math.round(usage.heapUsed / 1024 / 1024)
    });
  }, 60000);
}
```

### Slow Response Times

```typescript
// Add timing middleware
async function timeMiddleware(context, next) {
  const start = Date.now();
  await next();
  logger.debug("Handler timing", {
    handler: context.handler,
    duration: Date.now() - start
  });
}
```

### Connection Issues

```bash
# Enable connection debugging
DEBUG=elizaos:connection elizaos start

# Logs will show detailed connection info
[DEBUG] Connecting to Discord gateway
[DEBUG] WebSocket opened
[DEBUG] Received HELLO packet
```

## 🚀 Next Steps

After setting up logging:

1. **Configure Alerts** - Set up Sentry alerts for critical errors
2. **Create Dashboards** - Visualize logs in Kibana or similar
3. **Implement Metrics** - Add custom performance tracking
4. **Review Regularly** - Check logs for patterns and issues

For advanced topics:
- [Custom Logger Extensions](/docs/technical/logging)
- [Performance Optimization](/docs/technical/performance)
- [Production Deployment](/docs/technical/deployment)

---

**💡 Pro Tip**: During development, use `LOG_LEVEL=debug` with `LOG_FORMAT=pretty` for the best debugging experience. In production, switch to `LOG_LEVEL=info` with `LOG_FORMAT=json` for efficient log processing.