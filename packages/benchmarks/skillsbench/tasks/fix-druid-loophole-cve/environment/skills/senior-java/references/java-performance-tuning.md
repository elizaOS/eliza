# Java Performance Tuning Guide

Comprehensive guide for optimizing JVM applications and Spring Boot services.

## JVM Configuration

### Memory Settings

```bash
# Production JVM settings
java -Xms2g -Xmx2g \
     -XX:MetaspaceSize=256m \
     -XX:MaxMetaspaceSize=512m \
     -XX:+UseG1GC \
     -XX:MaxGCPauseMillis=200 \
     -jar application.jar
```

| Flag | Purpose | Recommendation |
|------|---------|----------------|
| `-Xms` | Initial heap size | Set equal to -Xmx for consistent performance |
| `-Xmx` | Maximum heap size | 50-75% of available RAM |
| `-XX:MetaspaceSize` | Initial metaspace | 256m for typical apps |
| `-XX:MaxMetaspaceSize` | Max metaspace | 512m-1g |

### Garbage Collection

#### G1GC (Recommended for most apps)

```bash
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:G1HeapRegionSize=16m
-XX:InitiatingHeapOccupancyPercent=45
```

#### ZGC (For low-latency requirements)

```bash
-XX:+UseZGC
-XX:+ZGenerational  # Java 21+
-XX:ZCollectionInterval=5
```

#### Shenandoah (Alternative low-pause collector)

```bash
-XX:+UseShenandoahGC
-XX:ShenandoahGCHeuristics=adaptive
```

### GC Logging

```bash
# Java 17+ unified logging
-Xlog:gc*:file=gc.log:time,uptime:filecount=5,filesize=10M

# Detailed GC logging
-Xlog:gc*,gc+phases=debug:file=gc-detailed.log:time,uptime,level,tags:filecount=5,filesize=20M
```

## Connection Pool Optimization

### HikariCP Configuration

```yaml
spring:
  datasource:
    hikari:
      # Pool sizing
      minimum-idle: 5
      maximum-pool-size: 20

      # Connection timeout
      connection-timeout: 30000  # 30 seconds
      idle-timeout: 600000       # 10 minutes
      max-lifetime: 1800000      # 30 minutes

      # Validation
      validation-timeout: 5000

      # Leak detection
      leak-detection-threshold: 60000  # 60 seconds

      # Performance
      auto-commit: true
      pool-name: MyAppPool
```

### Pool Size Formula

```
pool_size = (core_count * 2) + effective_spindle_count
```

For most applications: **10-20 connections** is optimal.

## Query Optimization

### Hibernate Settings

```yaml
spring:
  jpa:
    properties:
      hibernate:
        # Batch operations
        jdbc:
          batch_size: 25
          batch_versioned_data: true
        order_inserts: true
        order_updates: true

        # Fetch optimization
        default_batch_fetch_size: 25

        # Statistics (disable in production)
        generate_statistics: false

        # Query plan cache
        query:
          plan_cache_max_size: 2048
          plan_parameter_metadata_max_size: 128
```

### N+1 Query Prevention

```java
// BAD: N+1 queries
List<Order> orders = orderRepository.findAll();
for (Order order : orders) {
    order.getCustomer().getName();  // Additional query per order
}

// GOOD: Fetch join
@Query("SELECT o FROM Order o JOIN FETCH o.customer")
List<Order> findAllWithCustomer();

// GOOD: EntityGraph
@EntityGraph(attributePaths = {"customer", "items"})
List<Order> findByStatus(OrderStatus status);
```

### Batch Processing

```java
@Transactional
public void batchInsert(List<Product> products) {
    int batchSize = 50;
    for (int i = 0; i < products.size(); i++) {
        entityManager.persist(products.get(i));
        if (i > 0 && i % batchSize == 0) {
            entityManager.flush();
            entityManager.clear();
        }
    }
}
```

## Caching Strategies

### Spring Cache with Caffeine

```java
@Configuration
@EnableCaching
public class CacheConfig {

    @Bean
    public CacheManager cacheManager() {
        CaffeineCacheManager cacheManager = new CaffeineCacheManager();
        cacheManager.setCaffeine(Caffeine.newBuilder()
            .initialCapacity(100)
            .maximumSize(1000)
            .expireAfterWrite(Duration.ofMinutes(10))
            .recordStats());
        return cacheManager;
    }
}
```

```java
@Service
public class ProductService {

    @Cacheable(value = "products", key = "#id")
    public Product findById(Long id) {
        return productRepository.findById(id).orElseThrow();
    }

    @CachePut(value = "products", key = "#product.id")
    public Product update(Product product) {
        return productRepository.save(product);
    }

    @CacheEvict(value = "products", key = "#id")
    public void delete(Long id) {
        productRepository.deleteById(id);
    }

    @CacheEvict(value = "products", allEntries = true)
    public void clearCache() {
        // Cache cleared
    }
}
```

### Redis Cache

```yaml
spring:
  cache:
    type: redis
    redis:
      time-to-live: 600000  # 10 minutes
      cache-null-values: false
  redis:
    host: localhost
    port: 6379
    lettuce:
      pool:
        max-active: 8
        max-idle: 8
        min-idle: 2
```

## Async Processing

### Configuration

```java
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Override
    @Bean(name = "taskExecutor")
    public Executor getAsyncExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(10);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("async-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }

    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return new CustomAsyncExceptionHandler();
    }
}
```

### Async Service Methods

```java
@Service
public class NotificationService {

    @Async
    public CompletableFuture<Void> sendEmailAsync(String to, String subject, String body) {
        // Send email
        return CompletableFuture.completedFuture(null);
    }

    @Async
    public CompletableFuture<Report> generateReportAsync(ReportParams params) {
        Report report = generateReport(params);
        return CompletableFuture.completedFuture(report);
    }
}

// Usage
public void processOrder(Order order) {
    orderRepository.save(order);

    // Non-blocking email
    notificationService.sendEmailAsync(
        order.getCustomer().getEmail(),
        "Order Confirmation",
        "Your order has been placed"
    );
}
```

### Virtual Threads (Java 21+)

```java
@Configuration
public class VirtualThreadConfig {

    @Bean
    public TomcatProtocolHandlerCustomizer<?> protocolHandlerVirtualThreadExecutorCustomizer() {
        return protocolHandler -> {
            protocolHandler.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        };
    }
}
```

## Response Compression

```yaml
server:
  compression:
    enabled: true
    mime-types: application/json,application/xml,text/html,text/xml,text/plain
    min-response-size: 1024
```

## Monitoring and Profiling

### Micrometer Metrics

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  metrics:
    tags:
      application: ${spring.application.name}
    export:
      prometheus:
        enabled: true
```

```java
@Component
@RequiredArgsConstructor
public class CustomMetrics {

    private final MeterRegistry registry;

    @PostConstruct
    public void init() {
        Gauge.builder("custom.active.orders", this::getActiveOrderCount)
            .description("Number of active orders")
            .register(registry);
    }

    public void recordOrderProcessing(long duration) {
        registry.timer("order.processing.time").record(Duration.ofMillis(duration));
    }

    public void incrementOrderCount(String status) {
        registry.counter("orders.total", "status", status).increment();
    }
}
```

### JFR (Java Flight Recorder)

```bash
# Start with JFR enabled
java -XX:+FlightRecorder \
     -XX:StartFlightRecording=duration=60s,filename=recording.jfr \
     -jar application.jar

# Or start recording dynamically
jcmd <pid> JFR.start duration=60s filename=recording.jfr
```

## Performance Checklist

### Database

- [ ] Use connection pooling (HikariCP)
- [ ] Enable batch operations
- [ ] Add indexes for frequently queried columns
- [ ] Use pagination for large result sets
- [ ] Prevent N+1 queries with fetch joins
- [ ] Enable query caching where appropriate

### Caching

- [ ] Cache frequently accessed, rarely changed data
- [ ] Set appropriate TTL values
- [ ] Use distributed cache for clustered environments
- [ ] Monitor cache hit rates

### JVM

- [ ] Set appropriate heap sizes
- [ ] Choose right GC for workload
- [ ] Enable GC logging
- [ ] Monitor memory usage

### Application

- [ ] Use async processing for I/O operations
- [ ] Enable response compression
- [ ] Optimize JSON serialization
- [ ] Profile and identify bottlenecks

## Common Performance Anti-Patterns

1. **Unbounded queries** - Always use pagination
2. **Synchronous I/O in request threads** - Use async/reactive
3. **Creating objects in tight loops** - Reuse or pool objects
4. **String concatenation in loops** - Use StringBuilder
5. **Excessive logging in hot paths** - Use appropriate log levels
6. **Missing indexes** - Profile queries and add indexes
7. **Oversized connection pools** - Size based on actual needs
8. **Caching too much** - Cache wisely, monitor hit rates
