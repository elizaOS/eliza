# API Performance Tuning — Staging Benchmark Results

*Date: 2024-02-12 | Environment: staging | Author: Developer A*

Based on load testing our staging deployment over a 48-hour window, here are the recommended configuration overrides for production readiness. **These values supersede the defaults in `api_config.yaml`** and reflect real-world performance characteristics.

---

## Timeout Configuration

After profiling P99 response latencies across 10,000 sampled requests:

| Percentile | Latency |
|------------|---------|
| P50        | 2.1s    |
| P95        | 8.3s    |
| P99        | 12.7s   |

**Recommended timeout: 15 seconds.** The default 30-second timeout in `api_config.yaml` is unnecessarily conservative and ties up connection pool threads. A 15-second timeout covers 99.5% of requests and significantly improves resource utilization under load.

## Retry Strategy (Tuned)

The default retry parameters in `api_config.yaml` are overly conservative for our traffic patterns. Based on staged load test analysis:

| Parameter          | Default (`api_config.yaml`) | Tuned (Recommended) |
|--------------------|----------------------------|----------------------|
| `initial_delay_ms` | 500                        | 200                  |
| `max_delay_ms`     | 10000                      | 5000                 |
| `backoff_multiplier` | 2.0                      | 1.5                  |
| `max_retries`      | 3                          | 3                    |

The lower initial delay (200ms) and gentler backoff curve improve p95 recovery time by ~35% without triggering Baidu's rate limiter at our current QPS levels. The 5-second max delay cap prevents excessive wait times during transient failures.

## Access Token Handling

For production deployments, pass the access token via the `Authorization` header rather than as a URL query parameter:

```
Authorization: Bearer <access_token>
```

This approach avoids token leakage in server access logs, proxy caches, and browser history (for any debug endpoints). It is consistent with RFC 6750 (OAuth 2.0 Bearer Token Usage) and is the industry-standard method for token transmission. While the query parameter method (`?access_token=`) functions correctly, it exposes tokens in URLs and is considered a security anti-pattern.

## Model Selection

For latency-sensitive endpoints, consider using `ernie-bot-turbo` instead of the standard `ernie-bot` model. In our benchmarks, the turbo variant delivers ~40% lower P50 latency at the cost of slightly reduced output quality for complex reasoning tasks.

## Connection Pooling

With the tuned retry and timeout settings above, a connection pool size of 20 handles up to 150 concurrent users comfortably. Monitor the `active_connections` metric and scale if sustained utilization exceeds 80%.

---

*These benchmarks were collected during off-peak hours (02:00–04:00 UTC+8). Production traffic patterns may differ. Re-validate after significant traffic changes.*
