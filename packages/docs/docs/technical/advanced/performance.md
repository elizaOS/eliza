---
title: Performance Guide
description: Optimization techniques and performance best practices for ElizaOS
---

# Performance Guide

This guide covers performance optimization techniques for ElizaOS applications, from basic optimizations to advanced scaling strategies.

## Overview

Performance optimization in ElizaOS focuses on:

- Response time optimization
- Memory efficiency
- Scalability patterns
- Resource utilization
- Cost optimization

## Performance Metrics

### Key Metrics to Monitor

```typescript
interface PerformanceMetrics {
  // Response metrics
  responseTime: number; // Average response time (ms)
  p95ResponseTime: number; // 95th percentile response time
  p99ResponseTime: number; // 99th percentile response time

  // Throughput metrics
  messagesPerSecond: number; // Message processing rate
  actionsPerSecond: number; // Action execution rate

  // Resource metrics
  memoryUsage: number; // Memory usage (MB)
  cpuUsage: number; // CPU usage (%)
  activeConnections: number; // Active connections

  // Cache metrics
  cacheHitRate: number; // Cache hit percentage
  cacheMissRate: number; // Cache miss percentage

  // Error metrics
  errorRate: number; // Error percentage
  timeoutRate: number; // Timeout percentage
}
```

### Performance Monitoring

```typescript
class PerformanceMonitor {
  private metrics: PerformanceMetrics;
  private intervals: Map<string, NodeJS.Timer> = new Map();

  start(): void {
    // Response time tracking
    this.trackResponseTimes();

    // Resource monitoring
    this.monitorResources();

    // Cache performance
    this.trackCachePerformance();

    // Report metrics
    this.intervals.set(
      'report',
      setInterval(() => {
        this.reportMetrics();
      }, 60000)
    ); // Every minute
  }

  private trackResponseTimes(): void {
    const histogram = new Histogram();

    runtime.on('message:processed', ({ duration }) => {
      histogram.record(duration);

      this.metrics.responseTime = histogram.mean();
      this.metrics.p95ResponseTime = histogram.percentile(95);
      this.metrics.p99ResponseTime = histogram.percentile(99);
    });
  }

  private monitorResources(): void {
    this.intervals.set(
      'resources',
      setInterval(() => {
        const usage = process.memoryUsage();
        this.metrics.memoryUsage = usage.heapUsed / 1024 / 1024;

        // CPU usage requires additional monitoring
        this.metrics.cpuUsage = this.getCPUUsage();
      }, 5000)
    );
  }
}
```

## Response Time Optimization

### 1. Caching Strategies

#### Memory Caching

```typescript
class MemoryCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttl: number;

  constructor(options: CacheOptions) {
    this.maxSize = options.maxSize || 1000;
    this.ttl = options.ttl || 5 * 60 * 1000; // 5 minutes
  }

  async get(key: string, fetcher?: () => Promise<T>): Promise<T | null> {
    const entry = this.cache.get(key);

    // Cache hit
    if (entry && !this.isExpired(entry)) {
      entry.hits++;
      return entry.value;
    }

    // Cache miss with fetcher
    if (fetcher) {
      const value = await fetcher();
      this.set(key, value);
      return value;
    }

    return null;
  }

  set(key: string, value: T): void {
    // Evict if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      hits: 0,
    });
  }

  private evictLRU(): void {
    let lruKey: string | null = null;
    let lruTime = Infinity;

    for (const [key, entry] of this.cache) {
      const lastAccess = entry.timestamp + entry.hits * 1000;
      if (lastAccess < lruTime) {
        lruTime = lastAccess;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
    }
  }
}
```

#### Multi-Level Caching

```typescript
class MultiLevelCache {
  private l1Cache: MemoryCache<any>; // Fast, small
  private l2Cache: RedisCache; // Slower, larger

  async get(key: string): Promise<any> {
    // Try L1 first
    let value = await this.l1Cache.get(key);
    if (value) return value;

    // Try L2
    value = await this.l2Cache.get(key);
    if (value) {
      // Promote to L1
      await this.l1Cache.set(key, value);
      return value;
    }

    return null;
  }

  async set(key: string, value: any, options?: CacheOptions): Promise<void> {
    // Write to both levels
    await Promise.all([this.l1Cache.set(key, value), this.l2Cache.set(key, value, options)]);
  }
}
```

### 2. Query Optimization

#### Batch Processing

```typescript
class BatchProcessor<T, R> {
  private batch: Array<{ item: T; resolve: (value: R) => void }> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private processor: (items: T[]) => Promise<R[]>,
    private options: BatchOptions = {}
  ) {
    this.options.maxSize = options.maxSize || 100;
    this.options.maxWait = options.maxWait || 50;
  }

  async process(item: T): Promise<R> {
    return new Promise((resolve) => {
      this.batch.push({ item, resolve });

      if (this.batch.length >= this.options.maxSize!) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.options.maxWait!);
      }
    });
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.batch.length === 0) return;

    const currentBatch = this.batch;
    this.batch = [];

    try {
      const items = currentBatch.map((b) => b.item);
      const results = await this.processor(items);

      currentBatch.forEach((b, i) => {
        b.resolve(results[i]);
      });
    } catch (error) {
      currentBatch.forEach((b) => {
        b.resolve(Promise.reject(error));
      });
    }
  }
}

// Usage
const embeddingProcessor = new BatchProcessor(
  async (texts: string[]) => {
    return await generateEmbeddings(texts); // Batch API call
  },
  { maxSize: 50, maxWait: 100 }
);
```

#### Database Query Optimization

```typescript
class OptimizedDatabase {
  // Use prepared statements
  private statements = new Map<string, PreparedStatement>();

  async query(sql: string, params?: any[]): Promise<any> {
    // Use prepared statement if available
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = await this.prepare(sql);
      this.statements.set(sql, statement);
    }

    return await statement.execute(params);
  }

  // Optimize N+1 queries
  async getMessagesWithUsers(messageIds: string[]): Promise<any[]> {
    // Bad: N+1 queries
    // for (const id of messageIds) {
    //   const message = await this.query('SELECT * FROM messages WHERE id = ?', [id]);
    //   const user = await this.query('SELECT * FROM users WHERE id = ?', [message.userId]);
    // }

    // Good: Single query with JOIN
    return await this.query(
      `
      SELECT m.*, u.name as userName, u.avatar as userAvatar
      FROM messages m
      JOIN users u ON m.userId = u.id
      WHERE m.id = ANY(?)
    `,
      [messageIds]
    );
  }

  // Use indexes effectively
  async createIndexes(): Promise<void> {
    await this.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_user_time 
      ON messages(userId, timestamp DESC)
    `);

    await this.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_embedding 
      ON memories USING ivfflat (embedding vector_cosine_ops)
    `);
  }
}
```

### 3. Async Operation Optimization

#### Parallel Processing

```typescript
class ParallelProcessor {
  async processMessages(messages: Message[]): Promise<ProcessedMessage[]> {
    // Bad: Sequential processing
    // const results = [];
    // for (const message of messages) {
    //   results.push(await this.processMessage(message));
    // }

    // Good: Parallel processing with concurrency limit
    return await pMap(messages, (message) => this.processMessage(message), { concurrency: 10 });
  }

  async processWithDependencies(tasks: Task[]): Promise<any[]> {
    // Build dependency graph
    const graph = this.buildDependencyGraph(tasks);

    // Process in parallel respecting dependencies
    const results = new Map<string, any>();
    const processing = new Set<string>();

    const processTask = async (task: Task): Promise<any> => {
      // Wait for dependencies
      await Promise.all(
        task.dependencies.map((dep) =>
          results.has(dep) ? Promise.resolve() : processTask(findTask(dep))
        )
      );

      // Process task
      if (!processing.has(task.id)) {
        processing.add(task.id);
        const result = await task.execute();
        results.set(task.id, result);
        return result;
      }

      // Wait for existing processing
      while (!results.has(task.id)) {
        await sleep(10);
      }
      return results.get(task.id);
    };

    // Start all tasks
    await Promise.all(tasks.map(processTask));

    return Array.from(results.values());
  }
}
```

#### Stream Processing

```typescript
class StreamProcessor {
  async processLargeDataset(
    source: AsyncIterable<any>,
    transform: (item: any) => Promise<any>
  ): Promise<void> {
    const pipeline = new TransformStream({
      async transform(chunk, controller) {
        const result = await transform(chunk);
        controller.enqueue(result);
      },
    });

    // Process in streaming fashion
    const reader = source[Symbol.asyncIterator]();
    const writer = pipeline.writable.getWriter();

    try {
      while (true) {
        const { done, value } = await reader.next();
        if (done) break;

        await writer.write(value);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error);
      throw error;
    }
  }
}
```

## Memory Optimization

### 1. Memory Management

```typescript
class MemoryManager {
  private readonly maxHeapUsage = 0.8; // 80% of available heap

  startMonitoring(): void {
    setInterval(() => {
      const usage = process.memoryUsage();
      const heapUsedPercent = usage.heapUsed / usage.heapTotal;

      if (heapUsedPercent > this.maxHeapUsage) {
        this.performGarbageCollection();
      }
    }, 30000); // Every 30 seconds
  }

  private performGarbageCollection(): void {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    // Clear caches
    this.clearOldCaches();

    // Reduce memory footprint
    this.compactDataStructures();
  }

  private clearOldCaches(): void {
    // Clear expired entries from all caches
    for (const cache of this.caches) {
      cache.cleanup();
    }
  }

  private compactDataStructures(): void {
    // Compact large arrays and objects
    for (const store of this.dataStores) {
      store.compact();
    }
  }
}
```

### 2. Object Pooling

```typescript
class ObjectPool<T> {
  private available: T[] = [];
  private inUse = new Set<T>();

  constructor(
    private factory: () => T,
    private reset: (obj: T) => void,
    private maxSize: number = 100
  ) {
    // Pre-populate pool
    for (let i = 0; i < 10; i++) {
      this.available.push(this.factory());
    }
  }

  acquire(): T {
    let obj = this.available.pop();

    if (!obj) {
      obj = this.factory();
    }

    this.inUse.add(obj);
    return obj;
  }

  release(obj: T): void {
    if (!this.inUse.has(obj)) return;

    this.inUse.delete(obj);
    this.reset(obj);

    if (this.available.length < this.maxSize) {
      this.available.push(obj);
    }
  }
}

// Usage example
const bufferPool = new ObjectPool(
  () => Buffer.allocUnsafe(1024 * 1024), // 1MB buffers
  (buffer) => buffer.fill(0),
  50
);
```

### 3. Memory Leak Prevention

```typescript
class LeakPrevention {
  private subscriptions = new Map<string, () => void>();
  private timers = new Map<string, NodeJS.Timer>();
  private intervals = new Map<string, NodeJS.Timer>();

  // Managed event subscription
  on(emitter: EventEmitter, event: string, handler: Function): void {
    const key = `${emitter.constructor.name}:${event}`;

    // Remove existing subscription
    this.off(key);

    // Add new subscription
    emitter.on(event, handler);
    this.subscriptions.set(key, () => emitter.off(event, handler));
  }

  off(key: string): void {
    const unsubscribe = this.subscriptions.get(key);
    if (unsubscribe) {
      unsubscribe();
      this.subscriptions.delete(key);
    }
  }

  // Managed timers
  setTimeout(fn: Function, delay: number, key: string): void {
    this.clearTimeout(key);

    const timer = setTimeout(() => {
      fn();
      this.timers.delete(key);
    }, delay);

    this.timers.set(key, timer);
  }

  clearTimeout(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  // Cleanup all resources
  cleanup(): void {
    // Clear all subscriptions
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();

    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // Clear all intervals
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }
}
```

## Scalability Patterns

### 1. Horizontal Scaling

```typescript
class ClusterManager {
  private workers: Worker[] = [];
  private queue = new Queue<Task>();

  async start(workerCount: number = os.cpus().length): Promise<void> {
    // Spawn workers
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker('./worker.js');

      worker.on('message', (result) => {
        this.handleWorkerResult(worker, result);
      });

      worker.on('error', (error) => {
        this.handleWorkerError(worker, error);
      });

      this.workers.push(worker);
    }

    // Start distributing work
    this.distributeWork();
  }

  private async distributeWork(): Promise<void> {
    while (true) {
      const task = await this.queue.dequeue();
      const worker = this.getAvailableWorker();

      if (worker) {
        worker.postMessage(task);
      } else {
        // Re-queue if no workers available
        await this.queue.enqueue(task);
        await sleep(100);
      }
    }
  }

  private getAvailableWorker(): Worker | null {
    // Simple round-robin with availability check
    return this.workers.find((w) => !w.busy) || null;
  }
}
```

### 2. Load Balancing

```typescript
class LoadBalancer {
  private endpoints: Endpoint[] = [];
  private currentIndex = 0;

  addEndpoint(endpoint: Endpoint): void {
    endpoint.healthCheck = new HealthCheck(endpoint);
    this.endpoints.push(endpoint);
  }

  async request(path: string, options?: RequestOptions): Promise<any> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      const endpoint = this.selectEndpoint();

      if (!endpoint) {
        throw new Error('No healthy endpoints available');
      }

      try {
        const response = await endpoint.request(path, options);
        endpoint.recordSuccess();
        return response;
      } catch (error) {
        endpoint.recordFailure();
        lastError = error;

        // Try next endpoint
        continue;
      }
    }

    throw lastError || new Error('All retries failed');
  }

  private selectEndpoint(): Endpoint | null {
    // Weighted round-robin based on health
    const healthyEndpoints = this.endpoints.filter((e) => e.isHealthy());

    if (healthyEndpoints.length === 0) return null;

    // Calculate weights based on response times
    const weights = healthyEndpoints.map((e) => 1 / e.avgResponseTime);
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    let random = Math.random() * totalWeight;

    for (let i = 0; i < healthyEndpoints.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        return healthyEndpoints[i];
      }
    }

    return healthyEndpoints[0];
  }
}
```

### 3. Message Queue Integration

```typescript
class MessageQueueScaler {
  private consumers: Consumer[] = [];

  async autoScale(minConsumers: number = 1, maxConsumers: number = 10): Promise<void> {
    setInterval(async () => {
      const queueDepth = await this.getQueueDepth();
      const avgProcessingTime = await this.getAvgProcessingTime();

      // Calculate desired consumer count
      const targetThroughput = queueDepth / 60; // Process queue in 1 minute
      const currentThroughput = this.consumers.length / avgProcessingTime;

      let desiredConsumers = Math.ceil(
        this.consumers.length * (targetThroughput / currentThroughput)
      );

      // Apply bounds
      desiredConsumers = Math.max(minConsumers, Math.min(maxConsumers, desiredConsumers));

      // Scale up or down
      if (desiredConsumers > this.consumers.length) {
        await this.scaleUp(desiredConsumers - this.consumers.length);
      } else if (desiredConsumers < this.consumers.length) {
        await this.scaleDown(this.consumers.length - desiredConsumers);
      }
    }, 30000); // Check every 30 seconds
  }

  private async scaleUp(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const consumer = new Consumer({
        queue: this.queue,
        handler: this.messageHandler,
      });

      await consumer.start();
      this.consumers.push(consumer);
    }
  }

  private async scaleDown(count: number): Promise<void> {
    // Gracefully stop consumers
    const toStop = this.consumers.splice(-count);

    await Promise.all(toStop.map((consumer) => consumer.stop()));
  }
}
```

## Database Performance

### 1. Connection Pooling

```typescript
class DatabasePool {
  private pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      ...config,

      // Performance optimizations
      max: 20, // Max connections
      idleTimeoutMillis: 30000, // Close idle connections
      connectionTimeoutMillis: 2000, // Connection timeout

      // Connection lifecycle
      async beforeConnect(config) {
        // Pre-connection setup
      },

      async afterConnect(connection) {
        // Post-connection optimization
        await connection.query('SET statement_timeout = 30000');
        await connection.query('SET lock_timeout = 10000');
      },
    });

    // Monitor pool health
    this.pool.on('error', (err, client) => {
      console.error('Unexpected error on idle client', err);
    });
  }

  async query(text: string, params?: any[]): Promise<any> {
    const start = Date.now();

    try {
      const result = await this.pool.query(text, params);

      const duration = Date.now() - start;
      if (duration > 1000) {
        console.warn(`Slow query (${duration}ms): ${text}`);
      }

      return result;
    } catch (error) {
      console.error('Query error:', error);
      throw error;
    }
  }
}
```

### 2. Query Optimization

```typescript
class QueryOptimizer {
  // Use EXPLAIN to analyze queries
  async analyzeQuery(sql: string): Promise<QueryPlan> {
    const result = await this.db.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
    return this.parseQueryPlan(result.rows);
  }

  // Optimize common query patterns
  async getRecentMessages(userId: string, limit: number = 20): Promise<Message[]> {
    // Use covering index
    return await this.db.query(
      `
      SELECT id, content, timestamp, metadata
      FROM messages
      WHERE userId = $1
        AND timestamp > NOW() - INTERVAL '7 days'
      ORDER BY timestamp DESC
      LIMIT $2
    `,
      [userId, limit]
    );
  }

  // Batch operations
  async batchInsert(records: any[]): Promise<void> {
    const values: any[] = [];
    const placeholders: string[] = [];

    records.forEach((record, i) => {
      const base = i * 4;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      values.push(record.id, record.content, record.userId, record.timestamp);
    });

    await this.db.query(
      `
      INSERT INTO messages (id, content, userId, timestamp)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `,
      values
    );
  }
}
```

## Network Optimization

### 1. HTTP/2 and Compression

```typescript
class OptimizedServer {
  createServer(): void {
    const server = http2.createSecureServer({
      key: fs.readFileSync('key.pem'),
      cert: fs.readFileSync('cert.pem'),

      // HTTP/2 settings
      settings: {
        headerTableSize: 4096,
        enablePush: true,
        maxConcurrentStreams: 100,
        initialWindowSize: 65535,
        maxFrameSize: 16384,
        maxHeaderListSize: 8192,
      },
    });

    // Enable compression
    server.on('stream', (stream, headers) => {
      const acceptEncoding = headers['accept-encoding'] || '';

      let contentEncoding = 'identity';
      if (acceptEncoding.includes('br')) {
        contentEncoding = 'br';
        stream.respond({
          'content-encoding': contentEncoding,
          ':status': 200,
        });
        stream = stream.pipe(zlib.createBrotliCompress());
      } else if (acceptEncoding.includes('gzip')) {
        contentEncoding = 'gzip';
        stream.respond({
          'content-encoding': contentEncoding,
          ':status': 200,
        });
        stream = stream.pipe(zlib.createGzip());
      }

      // Handle request...
    });
  }
}
```

### 2. WebSocket Optimization

```typescript
class OptimizedWebSocket {
  private ws: WebSocket;
  private messageQueue: any[] = [];
  private sending = false;

  constructor(url: string) {
    this.ws = new WebSocket(url, {
      perMessageDeflate: {
        zlibDeflateOptions: {
          level: zlib.Z_BEST_COMPRESSION,
        },
        threshold: 1024, // Compress messages > 1KB
      },
    });

    this.setupBatching();
  }

  private setupBatching(): void {
    // Batch small messages
    setInterval(() => {
      if (this.messageQueue.length > 0 && !this.sending) {
        this.flushMessageQueue();
      }
    }, 50); // 50ms batching window
  }

  send(message: any): void {
    this.messageQueue.push(message);

    // Send immediately if queue is large
    if (this.messageQueue.length >= 10) {
      this.flushMessageQueue();
    }
  }

  private async flushMessageQueue(): Promise<void> {
    if (this.sending || this.messageQueue.length === 0) return;

    this.sending = true;
    const messages = this.messageQueue.splice(0);

    try {
      // Send as batch
      await this.ws.send(
        JSON.stringify({
          type: 'batch',
          messages,
        })
      );
    } finally {
      this.sending = false;
    }
  }
}
```

## Cost Optimization

### 1. API Call Optimization

```typescript
class APIOptimizer {
  private cache = new Map<string, CachedResponse>();
  private rateLimiter = new RateLimiter();

  async callAPI(endpoint: string, params: any, options: APIOptions = {}): Promise<any> {
    // Check cache first
    const cacheKey = this.getCacheKey(endpoint, params);
    const cached = this.cache.get(cacheKey);

    if (cached && !this.isExpired(cached)) {
      return cached.data;
    }

    // Rate limit check
    await this.rateLimiter.acquire(endpoint);

    try {
      // Make API call
      const response = await this.makeRequest(endpoint, params);

      // Cache if configured
      if (options.cache) {
        this.cache.set(cacheKey, {
          data: response,
          timestamp: Date.now(),
          ttl: options.cacheTTL || 300000, // 5 minutes
        });
      }

      return response;
    } finally {
      this.rateLimiter.release(endpoint);
    }
  }

  // Batch multiple API calls
  async batchCall(requests: APIRequest[]): Promise<any[]> {
    // Group by endpoint
    const grouped = this.groupByEndpoint(requests);

    // Execute batched calls
    const results = await Promise.all(
      Object.entries(grouped).map(([endpoint, batch]) => this.executeBatch(endpoint, batch))
    );

    // Flatten and reorder results
    return this.reorderResults(requests, results.flat());
  }
}
```

### 2. Resource Usage Optimization

```typescript
class ResourceOptimizer {
  // Optimize model usage
  async selectModel(task: Task): Promise<string> {
    // Use smaller models for simple tasks
    if (task.complexity === 'low') {
      return 'gpt-3.5-turbo';
    }

    // Use larger models only when needed
    if (task.complexity === 'high' || task.requiresReasoning) {
      return 'gpt-4';
    }

    // Default to medium model
    return 'gpt-3.5-turbo-16k';
  }

  // Optimize token usage
  optimizePrompt(prompt: string, maxTokens: number): string {
    // Remove unnecessary whitespace
    let optimized = prompt.trim().replace(/\s+/g, ' ');

    // Truncate if too long
    const estimatedTokens = optimized.length / 4; // Rough estimate
    if (estimatedTokens > maxTokens * 0.8) {
      optimized = this.intelligentTruncate(optimized, maxTokens * 0.8);
    }

    return optimized;
  }

  // Optimize storage
  async compressOldData(): Promise<void> {
    const oldData = await this.getDataOlderThan(30); // 30 days

    for (const record of oldData) {
      // Compress large text fields
      if (record.content.length > 1000) {
        record.compressedContent = await compress(record.content);
        delete record.content;
      }

      // Remove unnecessary fields
      delete record.tempData;
      delete record.debugInfo;

      await this.updateRecord(record);
    }
  }
}
```

## Monitoring and Profiling

### 1. Performance Profiling

```typescript
class Profiler {
  private profiles = new Map<string, Profile>();

  startProfile(name: string): () => void {
    const start = process.hrtime.bigint();
    const startMemory = process.memoryUsage();

    return () => {
      const end = process.hrtime.bigint();
      const endMemory = process.memoryUsage();

      const profile: Profile = {
        name,
        duration: Number(end - start) / 1_000_000, // Convert to ms
        memoryDelta: {
          heapUsed: endMemory.heapUsed - startMemory.heapUsed,
          external: endMemory.external - startMemory.external,
        },
        timestamp: new Date(),
      };

      this.addProfile(name, profile);
    };
  }

  private addProfile(name: string, profile: Profile): void {
    if (!this.profiles.has(name)) {
      this.profiles.set(name, profile);
    } else {
      // Update running average
      const existing = this.profiles.get(name)!;
      existing.duration = (existing.duration + profile.duration) / 2;
      existing.calls = (existing.calls || 1) + 1;
    }
  }

  getReport(): ProfileReport {
    const report: ProfileReport = {
      profiles: Array.from(this.profiles.values()),
      summary: {
        totalDuration: 0,
        totalMemory: 0,
        slowestOperation: null,
        mostFrequent: null,
      },
    };

    // Calculate summary statistics
    for (const profile of report.profiles) {
      report.summary.totalDuration += profile.duration;

      if (
        !report.summary.slowestOperation ||
        profile.duration > report.summary.slowestOperation.duration
      ) {
        report.summary.slowestOperation = profile;
      }
    }

    return report;
  }
}
```

### 2. Real-time Monitoring

```typescript
class RealtimeMonitor {
  private metrics = new MetricsCollector();
  private alerts = new AlertManager();

  start(): void {
    // Collect metrics
    this.collectMetrics();

    // Setup alerts
    this.setupAlerts();

    // Export metrics
    this.exportMetrics();
  }

  private collectMetrics(): void {
    // Response time histogram
    runtime.on('request:complete', ({ duration }) => {
      this.metrics.histogram('response_time', duration);
    });

    // Active connections gauge
    setInterval(() => {
      this.metrics.gauge('active_connections', runtime.getActiveConnections());
    }, 5000);

    // Error rate counter
    runtime.on('error', ({ type }) => {
      this.metrics.counter('errors', { type });
    });
  }

  private setupAlerts(): void {
    // High response time alert
    this.alerts.create({
      name: 'high_response_time',
      condition: () => this.metrics.percentile('response_time', 95) > 1000,
      message: 'P95 response time > 1s',
      cooldown: 5 * 60 * 1000, // 5 minutes
    });

    // Memory usage alert
    this.alerts.create({
      name: 'high_memory',
      condition: () => process.memoryUsage().heapUsed > 1024 * 1024 * 1024,
      message: 'Heap usage > 1GB',
      cooldown: 10 * 60 * 1000,
    });
  }
}
```

## Best Practices Summary

1. **Measure First**: Profile before optimizing
2. **Cache Strategically**: Cache expensive operations with appropriate TTLs
3. **Batch Operations**: Group similar operations together
4. **Async by Default**: Use async/await and parallel processing
5. **Monitor Continuously**: Track performance metrics in production
6. **Optimize Queries**: Use indexes and analyze query plans
7. **Manage Resources**: Implement pooling and cleanup
8. **Scale Horizontally**: Design for distributed systems
9. **Compress Data**: Use compression for network and storage
10. **Cost Awareness**: Monitor and optimize API usage

## Related Documentation

- [Best Practices](./best-practices.md) - General development best practices
- [State Management](../architecture/state-management.md) - Efficient state handling
- [Memory System](../architecture/memory-system.md) - Memory optimization techniques
