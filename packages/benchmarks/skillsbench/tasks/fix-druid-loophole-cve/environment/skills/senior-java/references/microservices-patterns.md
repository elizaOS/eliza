# Microservices Patterns with Spring Cloud

Comprehensive guide for building microservices with Spring Cloud.

## Service Decomposition

### Domain-Driven Design Approach

- **Bounded Contexts** - Each microservice owns a bounded context
- **Aggregates** - Single transaction boundary
- **Domain Events** - Communication between bounded contexts

### Decomposition Strategies

1. **By Business Capability** - Order service, Payment service, Inventory service
2. **By Subdomain** - Core, Supporting, Generic subdomains
3. **Strangler Pattern** - Gradual migration from monolith

## Spring Cloud Components

### Service Discovery (Eureka)

```yaml
# Eureka Server
spring:
  application:
    name: eureka-server

eureka:
  client:
    register-with-eureka: false
    fetch-registry: false
  server:
    enable-self-preservation: false
```

```yaml
# Eureka Client
eureka:
  client:
    service-url:
      defaultZone: http://localhost:8761/eureka/
  instance:
    prefer-ip-address: true
    instance-id: ${spring.application.name}:${random.uuid}
```

### API Gateway (Spring Cloud Gateway)

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: user-service
          uri: lb://user-service
          predicates:
            - Path=/api/users/**
          filters:
            - StripPrefix=1
            - AddRequestHeader=X-Request-Source, gateway

        - id: order-service
          uri: lb://order-service
          predicates:
            - Path=/api/orders/**
          filters:
            - StripPrefix=1
            - CircuitBreaker=name=orderCircuitBreaker,fallbackUri=forward:/fallback/orders
```

### Configuration Server

```yaml
# Config Server
spring:
  cloud:
    config:
      server:
        git:
          uri: https://github.com/myorg/config-repo
          default-label: main
          search-paths: '{application}'
```

```yaml
# Config Client
spring:
  config:
    import: configserver:http://localhost:8888
  cloud:
    config:
      fail-fast: true
      retry:
        max-attempts: 6
```

## Inter-Service Communication

### Synchronous (REST/OpenFeign)

```java
@FeignClient(name = "user-service", fallback = UserClientFallback.class)
public interface UserClient {

    @GetMapping("/api/users/{id}")
    UserDTO getUserById(@PathVariable Long id);

    @PostMapping("/api/users")
    UserDTO createUser(@RequestBody CreateUserDTO dto);
}

@Component
public class UserClientFallback implements UserClient {

    @Override
    public UserDTO getUserById(Long id) {
        return UserDTO.builder()
            .id(id)
            .username("Unknown")
            .build();
    }

    @Override
    public UserDTO createUser(CreateUserDTO dto) {
        throw new ServiceUnavailableException("User service unavailable");
    }
}
```

### Asynchronous (RabbitMQ/Kafka)

```java
// Publisher
@Service
@RequiredArgsConstructor
public class OrderEventPublisher {

    private final RabbitTemplate rabbitTemplate;

    public void publishOrderCreated(Order order) {
        OrderCreatedEvent event = new OrderCreatedEvent(
            order.getId(),
            order.getCustomerId(),
            order.getTotal(),
            Instant.now()
        );
        rabbitTemplate.convertAndSend("orders.exchange", "order.created", event);
    }
}

// Consumer
@Component
@Slf4j
public class OrderEventConsumer {

    @RabbitListener(queues = "inventory.order.created")
    public void handleOrderCreated(OrderCreatedEvent event) {
        log.info("Processing order: {}", event.getOrderId());
        // Update inventory
    }
}
```

## Resilience Patterns

### Circuit Breaker (Resilience4j)

```java
@Service
@RequiredArgsConstructor
public class PaymentService {

    private final PaymentClient paymentClient;

    @CircuitBreaker(name = "payment", fallbackMethod = "processPaymentFallback")
    @Retry(name = "payment")
    @TimeLimiter(name = "payment")
    public CompletableFuture<PaymentResult> processPayment(PaymentRequest request) {
        return CompletableFuture.supplyAsync(() ->
            paymentClient.process(request)
        );
    }

    private CompletableFuture<PaymentResult> processPaymentFallback(
            PaymentRequest request, Throwable t) {
        log.warn("Payment service unavailable, queuing for retry");
        return CompletableFuture.completedFuture(
            PaymentResult.pending(request.getOrderId())
        );
    }
}
```

```yaml
resilience4j:
  circuitbreaker:
    instances:
      payment:
        sliding-window-size: 10
        failure-rate-threshold: 50
        wait-duration-in-open-state: 10s
        permitted-number-of-calls-in-half-open-state: 3
  retry:
    instances:
      payment:
        max-attempts: 3
        wait-duration: 1s
        exponential-backoff-multiplier: 2
  timelimiter:
    instances:
      payment:
        timeout-duration: 3s
```

### Bulkhead Pattern

```java
@Bulkhead(name = "inventory", fallbackMethod = "checkInventoryFallback")
public boolean checkInventory(Long productId, int quantity) {
    return inventoryClient.check(productId, quantity);
}
```

## Distributed Tracing

### Micrometer + Zipkin

```yaml
management:
  tracing:
    sampling:
      probability: 1.0
  zipkin:
    tracing:
      endpoint: http://localhost:9411/api/v2/spans

logging:
  pattern:
    level: "%5p [${spring.application.name:},%X{traceId:-},%X{spanId:-}]"
```

### Custom Spans

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final Tracer tracer;

    public Order processOrder(CreateOrderDTO dto) {
        Span span = tracer.nextSpan().name("process-order").start();
        try (Tracer.SpanInScope ws = tracer.withSpan(span)) {
            span.tag("order.customer", dto.getCustomerId().toString());
            // Process order
            return order;
        } finally {
            span.end();
        }
    }
}
```

## Saga Pattern

### Choreography-Based Saga

```java
// Order Service - Initiates saga
@Transactional
public Order createOrder(CreateOrderDTO dto) {
    Order order = orderRepository.save(Order.pending(dto));
    eventPublisher.publish(new OrderCreatedEvent(order));
    return order;
}

// Payment Service - Handles event
@EventListener
public void handleOrderCreated(OrderCreatedEvent event) {
    try {
        Payment payment = paymentService.process(event.getOrderId());
        eventPublisher.publish(new PaymentCompletedEvent(payment));
    } catch (PaymentException e) {
        eventPublisher.publish(new PaymentFailedEvent(event.getOrderId(), e.getMessage()));
    }
}

// Order Service - Compensating transaction
@EventListener
public void handlePaymentFailed(PaymentFailedEvent event) {
    orderService.cancelOrder(event.getOrderId(), event.getReason());
}
```

### Orchestration-Based Saga

```java
@Service
@RequiredArgsConstructor
public class OrderSagaOrchestrator {

    private final OrderService orderService;
    private final PaymentClient paymentClient;
    private final InventoryClient inventoryClient;

    @Transactional
    public Order executeOrderSaga(CreateOrderDTO dto) {
        // Step 1: Create order
        Order order = orderService.createPendingOrder(dto);

        try {
            // Step 2: Reserve inventory
            inventoryClient.reserve(order.getId(), dto.getItems());

            // Step 3: Process payment
            paymentClient.process(order.getId(), dto.getTotal());

            // Step 4: Confirm order
            return orderService.confirmOrder(order.getId());

        } catch (InventoryException e) {
            // Compensate: Cancel order
            orderService.cancelOrder(order.getId(), "Inventory unavailable");
            throw e;

        } catch (PaymentException e) {
            // Compensate: Release inventory, cancel order
            inventoryClient.release(order.getId());
            orderService.cancelOrder(order.getId(), "Payment failed");
            throw e;
        }
    }
}
```

## Event Sourcing

```java
@Entity
@Table(name = "domain_events")
public class DomainEvent {
    @Id
    private UUID eventId;
    private String aggregateId;
    private String aggregateType;
    private String eventType;
    private String payload;
    private Instant occurredAt;
    private Long version;
}

@Service
public class EventStore {

    public void append(String aggregateId, DomainEvent event) {
        event.setVersion(getNextVersion(aggregateId));
        eventRepository.save(event);
        eventPublisher.publish(event);
    }

    public List<DomainEvent> getEvents(String aggregateId) {
        return eventRepository.findByAggregateIdOrderByVersionAsc(aggregateId);
    }

    public <T> T reconstruct(String aggregateId, Class<T> aggregateType) {
        List<DomainEvent> events = getEvents(aggregateId);
        return eventSourcedAggregate.replay(events, aggregateType);
    }
}
```

## CQRS Pattern

```java
// Command side
@Service
public class OrderCommandService {

    @Transactional
    public void createOrder(CreateOrderCommand cmd) {
        Order order = Order.create(cmd);
        orderRepository.save(order);
        eventPublisher.publish(new OrderCreatedEvent(order));
    }
}

// Query side
@Service
public class OrderQueryService {

    private final OrderReadRepository readRepository;

    public OrderView findById(Long id) {
        return readRepository.findById(id)
            .orElseThrow(() -> new NotFoundException("Order not found"));
    }

    public Page<OrderSummary> findByCustomer(Long customerId, Pageable pageable) {
        return readRepository.findByCustomerId(customerId, pageable);
    }
}

// Event handler updates read model
@EventListener
public void handleOrderCreated(OrderCreatedEvent event) {
    OrderView view = OrderView.from(event);
    orderReadRepository.save(view);
}
```

## Deployment Patterns

### Blue-Green Deployment

```yaml
# Kubernetes service with selector
apiVersion: v1
kind: Service
metadata:
  name: order-service
spec:
  selector:
    app: order-service
    version: blue  # Switch to 'green' for deployment
  ports:
    - port: 80
      targetPort: 8080
```

### Canary Release

```yaml
# Istio VirtualService
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: order-service
spec:
  hosts:
    - order-service
  http:
    - route:
        - destination:
            host: order-service
            subset: stable
          weight: 90
        - destination:
            host: order-service
            subset: canary
          weight: 10
```

## Best Practices Checklist

- [ ] Each service has its own database
- [ ] Services communicate through well-defined APIs
- [ ] Implement circuit breakers for external calls
- [ ] Use distributed tracing for debugging
- [ ] Implement health checks and readiness probes
- [ ] Centralize configuration management
- [ ] Use service discovery for dynamic routing
- [ ] Implement proper logging with correlation IDs
- [ ] Design for failure and implement retries
- [ ] Version your APIs
