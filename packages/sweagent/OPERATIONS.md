# SWE-agent Operations Guide

This document covers production operations including deployment, monitoring, and rollback procedures.

## Prerequisites

- Docker installed and running
- API keys configured (OPENAI_API_KEY or ANTHROPIC_API_KEY)
- Git for version control

## Deployment

### Rust (Native Binary)

```bash
cd packages/sweagent/rust
cargo build --release
./target/release/sweagent --help
```

### TypeScript (npm)

```bash
cd packages/sweagent/typescript
bun install
bun run build
npx @elizaos/sweagent --help
```

### Python (pip)

```bash
cd packages/sweagent/python
pip install -e .
sweagent --help
```

## Health Checks

### Rust Health Check API

```rust
use elizaos_sweagent::health_check;

let status = health_check().await;
if !status.healthy {
    eprintln!("Health check failed: {:?}", status.components);
}
```

### HTTP Endpoint (if using web service)

```bash
curl http://localhost:8080/health
```

Expected response:
```json
{
  "healthy": true,
  "components": {
    "docker": {"healthy": true, "message": "Docker daemon is running"},
    "api_keys": {"healthy": true, "message": "API keys configured"}
  }
}
```

## Monitoring

### Metrics Collection

The Rust implementation provides built-in metrics via `AgentMetrics`:

```rust
use elizaos_sweagent::{AgentMetrics, MetricsMonitor, AlertThresholds};
use std::sync::Arc;

let metrics = Arc::new(AgentMetrics::new());
let thresholds = AlertThresholds {
    cost_limit: 50.0,            // Alert at $50
    failure_rate_percent: 15.0,  // Alert at 15% failure rate
    execution_time_ms: 300_000,  // Alert at 5 minute avg
    api_calls_limit: 5_000,      // Alert at 5k API calls
};

let monitor = MetricsMonitor::new(metrics.clone(), thresholds);
```

### Available Metrics

| Metric | Description |
|--------|-------------|
| `runs_started` | Total agent runs initiated |
| `runs_completed` | Successful completions |
| `runs_failed` | Failed runs |
| `total_cost` | Accumulated API costs ($) |
| `total_tokens_sent` | Input tokens to LLM |
| `total_tokens_received` | Output tokens from LLM |
| `total_api_calls` | Number of API requests |
| `total_execution_time_ms` | Total wall clock time |

### Alerting

Configure webhook alerts for external notification systems:

```rust
use elizaos_sweagent::{WebhookAlertHandler, AlertSeverity};

let slack_handler = WebhookAlertHandler::new(
    "https://hooks.slack.com/services/...",
    AlertSeverity::Warning,
);
monitor.add_handler(Box::new(slack_handler));
```

## Rollback Procedures

### Version Rollback

#### 1. Identify Current Version

```bash
# Rust
./target/release/sweagent --version

# TypeScript
npm show @elizaos/sweagent version

# Python
pip show sweagent | grep Version
```

#### 2. Rollback to Previous Version

**Rust (Git-based):**
```bash
git log --oneline packages/sweagent/rust
git checkout <previous-commit> -- packages/sweagent/rust
cargo build --release
```

**TypeScript (npm):**
```bash
npm install @elizaos/sweagent@<previous-version>
```

**Python (pip):**
```bash
pip install sweagent==<previous-version>
```

### Configuration Rollback

Configurations are stored in YAML files. To rollback:

```bash
# List config history
git log --oneline config/

# Restore previous config
git checkout <commit> -- config/default.yaml

# Verify config validity
sweagent run --config config/default.yaml --dry-run
```

### Docker Container Rollback

If using Docker deployment:

```bash
# List available images
docker images elizaos/sweagent

# Rollback to previous tag
docker stop sweagent-current
docker run -d --name sweagent-rollback elizaos/sweagent:<previous-tag>

# Verify rollback
docker logs sweagent-rollback
```

### Trajectory Recovery

If a run was interrupted or failed:

```bash
# List incomplete trajectories
sweagent remove-unfinished --base-dir ./trajectories

# Re-run specific instance
sweagent run --config config.yaml --problem_statement.id <instance-id>
```

## Incident Response

### High Failure Rate

1. Check error logs:
   ```bash
   grep -i error trajectories/*.traj | tail -20
   ```

2. Review common exit statuses:
   ```bash
   sweagent quick-stats ./trajectories
   ```

3. If API-related, verify keys:
   ```bash
   curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"
   ```

### Cost Overrun

1. Stop batch runs immediately:
   ```bash
   pkill -f "sweagent run"
   ```

2. Review cost breakdown:
   ```bash
   sweagent quick-stats ./trajectories | grep -i cost
   ```

3. Lower cost limits in config:
   ```yaml
   agent:
     model:
       per_instance_cost_limit: 1.0
   ```

### Docker Issues

1. Check Docker status:
   ```bash
   docker info
   docker ps -a | grep swe-agent
   ```

2. Clean up orphaned containers:
   ```bash
   docker rm $(docker ps -aq --filter "name=swe-agent")
   ```

3. Pull fresh image:
   ```bash
   docker pull python:3.11
   ```

## Backup Procedures

### Trajectory Backup

```bash
# Compress and backup trajectories
tar -czvf trajectories-$(date +%Y%m%d).tar.gz ./trajectories/

# Upload to cloud storage
aws s3 cp trajectories-*.tar.gz s3://your-bucket/backups/
```

### Configuration Backup

All configurations should be version controlled:

```bash
git add config/
git commit -m "Backup configs before deployment"
git push origin main
```

## Performance Tuning

### Batch Processing

For large batches, optimize with:

```yaml
num_workers: 4                    # Parallel workers
random_delay_multiplier: 0.5      # Reduce delay between runs
agent:
  model:
    max_output_tokens: 2048       # Limit output length
```

### Memory Management

For long-running processes:

```bash
# Monitor memory usage
ps aux | grep sweagent

# Set memory limits (Docker)
docker run --memory=4g elizaos/sweagent
```

## Contact

For production issues:
- GitHub Issues: https://github.com/elizaos/eliza/issues
- Discord: [elizaOS community]
