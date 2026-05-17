# JPA/Hibernate Best Practices Guide

Comprehensive guide for building efficient data layers with Spring Data JPA and Hibernate.

## Entity Design

### Basic Entity Structure

```java
@Entity
@Table(name = "products")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Product {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 255)
    private String name;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(nullable = false, precision = 10, scale = 2)
    private BigDecimal price;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private ProductStatus status;

    @CreatedDate
    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @LastModifiedDate
    @Column(nullable = false)
    private LocalDateTime updatedAt;

    @Version
    private Long version;
}
```

### Relationship Mappings

#### One-to-Many / Many-to-One

```java
@Entity
public class Order {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "customer_id", nullable = false)
    private Customer customer;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem> items = new ArrayList<>();

    // Helper methods for bidirectional relationship
    public void addItem(OrderItem item) {
        items.add(item);
        item.setOrder(this);
    }

    public void removeItem(OrderItem item) {
        items.remove(item);
        item.setOrder(null);
    }
}

@Entity
public class OrderItem {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "product_id", nullable = false)
    private Product product;

    private Integer quantity;
    private BigDecimal price;
}
```

#### Many-to-Many

```java
@Entity
public class Student {
    @Id
    private Long id;

    @ManyToMany(cascade = {CascadeType.PERSIST, CascadeType.MERGE})
    @JoinTable(
        name = "student_course",
        joinColumns = @JoinColumn(name = "student_id"),
        inverseJoinColumns = @JoinColumn(name = "course_id")
    )
    private Set<Course> courses = new HashSet<>();

    public void addCourse(Course course) {
        courses.add(course);
        course.getStudents().add(this);
    }

    public void removeCourse(Course course) {
        courses.remove(course);
        course.getStudents().remove(this);
    }
}
```

## Repository Patterns

### Basic Repository

```java
@Repository
public interface ProductRepository extends JpaRepository<Product, Long>,
                                          JpaSpecificationExecutor<Product> {

    Optional<Product> findByName(String name);

    List<Product> findByStatusAndPriceGreaterThan(ProductStatus status, BigDecimal price);

    @Query("SELECT p FROM Product p WHERE p.category.id = :categoryId AND p.status = 'ACTIVE'")
    List<Product> findActiveByCategory(@Param("categoryId") Long categoryId);

    @Query(value = "SELECT * FROM products WHERE LOWER(name) LIKE LOWER(CONCAT('%', :search, '%'))",
           nativeQuery = true)
    Page<Product> searchByName(@Param("search") String search, Pageable pageable);

    @Modifying
    @Query("UPDATE Product p SET p.status = :status WHERE p.id IN :ids")
    int updateStatusByIds(@Param("ids") List<Long> ids, @Param("status") ProductStatus status);
}
```

### Specifications for Dynamic Queries

```java
public class ProductSpecifications {

    public static Specification<Product> hasName(String name) {
        return (root, query, cb) ->
            name == null ? null : cb.like(cb.lower(root.get("name")), "%" + name.toLowerCase() + "%");
    }

    public static Specification<Product> hasCategory(Long categoryId) {
        return (root, query, cb) ->
            categoryId == null ? null : cb.equal(root.get("category").get("id"), categoryId);
    }

    public static Specification<Product> hasPriceBetween(BigDecimal min, BigDecimal max) {
        return (root, query, cb) -> {
            if (min == null && max == null) return null;
            if (min == null) return cb.lessThanOrEqualTo(root.get("price"), max);
            if (max == null) return cb.greaterThanOrEqualTo(root.get("price"), min);
            return cb.between(root.get("price"), min, max);
        };
    }

    public static Specification<Product> isActive() {
        return (root, query, cb) ->
            cb.equal(root.get("status"), ProductStatus.ACTIVE);
    }
}

// Usage in service
public Page<Product> search(ProductSearchCriteria criteria, Pageable pageable) {
    Specification<Product> spec = Specification
        .where(ProductSpecifications.hasName(criteria.getName()))
        .and(ProductSpecifications.hasCategory(criteria.getCategoryId()))
        .and(ProductSpecifications.hasPriceBetween(criteria.getMinPrice(), criteria.getMaxPrice()))
        .and(ProductSpecifications.isActive());

    return productRepository.findAll(spec, pageable);
}
```

## N+1 Query Prevention

### Problem: N+1 Queries

```java
// BAD: This causes N+1 queries
List<Order> orders = orderRepository.findAll();
for (Order order : orders) {
    // Each access triggers a separate query!
    String customerName = order.getCustomer().getName();
}
```

### Solution 1: Entity Graph

```java
@Repository
public interface OrderRepository extends JpaRepository<Order, Long> {

    @EntityGraph(attributePaths = {"customer", "items", "items.product"})
    List<Order> findAll();

    @EntityGraph(attributePaths = {"customer"})
    Optional<Order> findWithCustomerById(Long id);
}

// Or define named entity graph on entity
@Entity
@NamedEntityGraph(
    name = "Order.withCustomerAndItems",
    attributeNodes = {
        @NamedAttributeNode("customer"),
        @NamedAttributeNode(value = "items", subgraph = "items-subgraph")
    },
    subgraphs = {
        @NamedSubgraph(name = "items-subgraph", attributeNodes = @NamedAttributeNode("product"))
    }
)
public class Order { ... }

// Use in repository
@EntityGraph(value = "Order.withCustomerAndItems")
List<Order> findByCustomerId(Long customerId);
```

### Solution 2: Fetch Join (JPQL)

```java
@Query("SELECT DISTINCT o FROM Order o " +
       "JOIN FETCH o.customer " +
       "JOIN FETCH o.items i " +
       "JOIN FETCH i.product " +
       "WHERE o.status = :status")
List<Order> findByStatusWithDetails(@Param("status") OrderStatus status);
```

### Solution 3: Batch Fetching

```java
@Entity
public class Order {
    @OneToMany(mappedBy = "order")
    @BatchSize(size = 25)  // Fetch in batches of 25
    private List<OrderItem> items;
}

// Or configure globally in application.yml
spring:
  jpa:
    properties:
      hibernate:
        default_batch_fetch_size: 25
```

## Projections

### Interface Projection

```java
public interface ProductSummary {
    Long getId();
    String getName();
    BigDecimal getPrice();

    @Value("#{target.category.name}")
    String getCategoryName();
}

@Repository
public interface ProductRepository extends JpaRepository<Product, Long> {

    List<ProductSummary> findByStatus(ProductStatus status);

    @Query("SELECT p.id as id, p.name as name, p.price as price FROM Product p WHERE p.category.id = :categoryId")
    List<ProductSummary> findSummaryByCategory(@Param("categoryId") Long categoryId);
}
```

### DTO Projection

```java
public record ProductDTO(Long id, String name, BigDecimal price, String categoryName) {}

@Query("SELECT new com.example.dto.ProductDTO(p.id, p.name, p.price, c.name) " +
       "FROM Product p JOIN p.category c WHERE p.status = 'ACTIVE'")
List<ProductDTO> findActiveProductsWithCategory();
```

## Caching

### First-Level Cache (Session Cache)

- Automatic within transaction
- Prevents duplicate queries for same entity

### Second-Level Cache (Shared Cache)

```java
@Entity
@Cacheable
@Cache(usage = CacheConcurrencyStrategy.READ_WRITE, region = "products")
public class Product {
    // ...

    @Cache(usage = CacheConcurrencyStrategy.READ_WRITE)
    @OneToMany(mappedBy = "product")
    private List<Review> reviews;
}
```

```yaml
# application.yml
spring:
  jpa:
    properties:
      hibernate:
        cache:
          use_second_level_cache: true
          use_query_cache: true
          region:
            factory_class: org.hibernate.cache.jcache.JCacheRegionFactory
        javax:
          cache:
            provider: com.github.benmanes.caffeine.jcache.spi.CaffeineCachingProvider
```

### Query Cache

```java
@QueryHints(@QueryHint(name = org.hibernate.jpa.QueryHints.HINT_CACHEABLE, value = "true"))
List<Product> findByCategory(Category category);
```

## Transaction Management

### Service Layer Transactions

```java
@Service
@Transactional(readOnly = true)  // Default read-only for queries
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepository;

    public Order findById(Long id) {
        return orderRepository.findById(id)
            .orElseThrow(() -> new NotFoundException("Order not found"));
    }

    @Transactional  // Override for write operations
    public Order createOrder(CreateOrderDTO dto) {
        Order order = Order.create(dto);
        return orderRepository.save(order);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void updateOrderStatus(Long orderId, OrderStatus status) {
        // Runs in new transaction
        Order order = orderRepository.findById(orderId).orElseThrow();
        order.setStatus(status);
    }

    @Transactional(isolation = Isolation.SERIALIZABLE)
    public void processPayment(Long orderId) {
        // High isolation for critical operations
    }
}
```

### Optimistic Locking

```java
@Entity
public class Product {
    @Version
    private Long version;
}

// Handle OptimisticLockException
@Transactional
public Product updatePrice(Long id, BigDecimal newPrice) {
    try {
        Product product = productRepository.findById(id).orElseThrow();
        product.setPrice(newPrice);
        return productRepository.save(product);
    } catch (OptimisticLockException e) {
        throw new ConcurrentModificationException("Product was modified by another user");
    }
}
```

## Performance Tips

### 1. Use Proper Fetch Strategy

```java
// LAZY for collections (default for @OneToMany, @ManyToMany)
@OneToMany(fetch = FetchType.LAZY)
private List<OrderItem> items;

// LAZY for single associations when not always needed
@ManyToOne(fetch = FetchType.LAZY)
private Category category;
```

### 2. Avoid OSIV Anti-Pattern

```yaml
spring:
  jpa:
    open-in-view: false  # Disable Open Session in View
```

### 3. Use Pagination

```java
Page<Product> findByCategory(Category category, Pageable pageable);

// Or use Slice for infinite scroll
Slice<Product> findByStatus(ProductStatus status, Pageable pageable);
```

### 4. Bulk Operations

```java
@Modifying
@Query("UPDATE Product p SET p.price = p.price * :multiplier WHERE p.category.id = :categoryId")
int updatePricesByCategory(@Param("categoryId") Long categoryId, @Param("multiplier") BigDecimal multiplier);

@Modifying
@Query("DELETE FROM Product p WHERE p.status = 'DELETED' AND p.deletedAt < :cutoff")
int deleteOldProducts(@Param("cutoff") LocalDateTime cutoff);
```

### 5. Proper Indexing

```java
@Entity
@Table(name = "products", indexes = {
    @Index(name = "idx_product_name", columnList = "name"),
    @Index(name = "idx_product_category_status", columnList = "category_id, status"),
    @Index(name = "idx_product_created", columnList = "created_at DESC")
})
public class Product { ... }
```

## Common Pitfalls

1. **N+1 Queries** - Always use EntityGraph or fetch joins for related entities
2. **Eager Fetching** - Avoid EAGER fetch type, use LAZY with explicit fetching
3. **Missing @Transactional** - Ensure write operations are transactional
4. **Large Result Sets** - Always use pagination
5. **Orphan Entities** - Use `orphanRemoval = true` for owned collections
6. **Detached Entity Issues** - Merge detached entities before modifying
7. **Missing Indexes** - Add indexes for frequently queried columns
8. **toString() Cycles** - Exclude relationship fields from toString
