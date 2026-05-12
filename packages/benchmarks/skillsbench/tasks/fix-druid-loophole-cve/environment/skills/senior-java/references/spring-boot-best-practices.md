# Spring Boot Best Practices

Comprehensive guide for building production-ready Spring Boot applications.

## Project Structure

### Layered Architecture

```
src/main/java/com/example/myapp/
├── MyAppApplication.java          # Main class
├── config/                        # Configuration classes
│   ├── SecurityConfig.java
│   ├── OpenApiConfig.java
│   └── AsyncConfig.java
├── controller/                    # REST controllers
│   ├── UserController.java
│   └── ProductController.java
├── service/                       # Business logic
│   ├── UserService.java
│   └── ProductService.java
├── repository/                    # Data access
│   ├── UserRepository.java
│   └── ProductRepository.java
├── entity/                        # JPA entities
│   ├── User.java
│   └── Product.java
├── dto/                           # Data transfer objects
│   ├── UserDTO.java
│   └── ProductDTO.java
├── mapper/                        # DTO mappers
│   ├── UserMapper.java
│   └── ProductMapper.java
├── exception/                     # Exception handling
│   ├── GlobalExceptionHandler.java
│   └── ResourceNotFoundException.java
└── security/                      # Security components
    ├── JwtTokenProvider.java
    └── JwtAuthenticationFilter.java
```

### Package Naming Conventions

- Use lowercase, dot-separated package names
- Group by feature or layer (prefer layer for smaller apps)
- Example: `com.example.myapp.user.controller`

## Configuration Management

### Profile-Based Configuration

```yaml
# application.yml - Common configuration
spring:
  application:
    name: my-service
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:dev}

---
# Development profile
spring:
  config:
    activate:
      on-profile: dev
  datasource:
    url: jdbc:postgresql://localhost:5432/myapp_dev
    username: postgres
    password: postgres
  jpa:
    hibernate:
      ddl-auto: update
    show-sql: true

---
# Production profile
spring:
  config:
    activate:
      on-profile: prod
  datasource:
    url: ${DATABASE_URL}
    username: ${DATABASE_USERNAME}
    password: ${DATABASE_PASSWORD}
  jpa:
    hibernate:
      ddl-auto: validate
    show-sql: false
```

### Environment Variables

- Use `${VAR:default}` syntax for fallbacks
- Store secrets in environment variables or secret managers
- Never commit sensitive data to version control

```yaml
jwt:
  secret: ${JWT_SECRET:change-me-in-production}
  expiration: ${JWT_EXPIRATION:86400000}
```

## REST API Design

### Controller Structure

```java
@RestController
@RequestMapping("/api/v1/users")
@RequiredArgsConstructor
@Tag(name = "Users", description = "User management APIs")
public class UserController {

    private final UserService userService;

    @GetMapping
    @Operation(summary = "Get all users with pagination")
    public ResponseEntity<Page<UserDTO>> findAll(
            @PageableDefault(size = 20, sort = "createdAt", direction = Sort.Direction.DESC)
            Pageable pageable) {
        return ResponseEntity.ok(userService.findAll(pageable));
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get user by ID")
    public ResponseEntity<UserDTO> findById(@PathVariable Long id) {
        return ResponseEntity.ok(userService.findById(id));
    }

    @PostMapping
    @Operation(summary = "Create a new user")
    public ResponseEntity<UserDTO> create(@Valid @RequestBody CreateUserDTO dto) {
        UserDTO created = userService.create(dto);
        URI location = ServletUriComponentsBuilder
            .fromCurrentRequest()
            .path("/{id}")
            .buildAndExpand(created.getId())
            .toUri();
        return ResponseEntity.created(location).body(created);
    }

    @PutMapping("/{id}")
    @Operation(summary = "Update an existing user")
    public ResponseEntity<UserDTO> update(
            @PathVariable Long id,
            @Valid @RequestBody UpdateUserDTO dto) {
        return ResponseEntity.ok(userService.update(id, dto));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Operation(summary = "Delete a user")
    public void delete(@PathVariable Long id) {
        userService.delete(id);
    }
}
```

### HTTP Status Codes

| Code | Usage |
|------|-------|
| 200 OK | Successful GET, PUT |
| 201 Created | Successful POST with resource creation |
| 204 No Content | Successful DELETE |
| 400 Bad Request | Validation errors |
| 401 Unauthorized | Authentication required |
| 403 Forbidden | Insufficient permissions |
| 404 Not Found | Resource not found |
| 409 Conflict | Resource conflict (duplicate) |
| 500 Internal Server Error | Server-side errors |

### Error Response Format (RFC 7807)

```java
@Data
@Builder
public class ProblemDetail {
    private String type;
    private String title;
    private int status;
    private String detail;
    private String instance;
    private Map<String, Object> properties;
}
```

## Validation

### Request Validation

```java
@Data
public class CreateUserDTO {

    @NotBlank(message = "Username is required")
    @Size(min = 3, max = 50, message = "Username must be 3-50 characters")
    @Pattern(regexp = "^[a-zA-Z0-9_]+$", message = "Username can only contain letters, numbers, and underscores")
    private String username;

    @NotBlank(message = "Email is required")
    @Email(message = "Invalid email format")
    private String email;

    @NotBlank(message = "Password is required")
    @Size(min = 8, message = "Password must be at least 8 characters")
    @Pattern(regexp = "^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).*$",
             message = "Password must contain uppercase, lowercase, and number")
    private String password;

    @PastOrPresent(message = "Birth date cannot be in the future")
    private LocalDate birthDate;
}
```

### Custom Validators

```java
@Target({ElementType.FIELD})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = UniqueEmailValidator.class)
public @interface UniqueEmail {
    String message() default "Email already exists";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}

@Component
@RequiredArgsConstructor
public class UniqueEmailValidator implements ConstraintValidator<UniqueEmail, String> {

    private final UserRepository userRepository;

    @Override
    public boolean isValid(String email, ConstraintValidatorContext context) {
        return email != null && !userRepository.existsByEmail(email);
    }
}
```

## Exception Handling

### Global Exception Handler

```java
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    @ExceptionHandler(ResourceNotFoundException.class)
    public ResponseEntity<ProblemDetail> handleNotFound(
            ResourceNotFoundException ex, HttpServletRequest request) {
        log.warn("Resource not found: {}", ex.getMessage());

        ProblemDetail problem = ProblemDetail.builder()
            .type("https://api.example.com/errors/not-found")
            .title("Resource Not Found")
            .status(HttpStatus.NOT_FOUND.value())
            .detail(ex.getMessage())
            .instance(request.getRequestURI())
            .build();

        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(problem);
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ProblemDetail> handleAccessDenied(
            AccessDeniedException ex, HttpServletRequest request) {
        log.warn("Access denied: {}", request.getRequestURI());

        ProblemDetail problem = ProblemDetail.builder()
            .type("https://api.example.com/errors/forbidden")
            .title("Access Denied")
            .status(HttpStatus.FORBIDDEN.value())
            .detail("You don't have permission to access this resource")
            .instance(request.getRequestURI())
            .build();

        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(problem);
    }

    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(
            MethodArgumentNotValidException ex,
            HttpHeaders headers,
            HttpStatusCode status,
            WebRequest request) {

        Map<String, String> errors = new HashMap<>();
        ex.getBindingResult().getFieldErrors().forEach(error ->
            errors.put(error.getField(), error.getDefaultMessage()));

        ProblemDetail problem = ProblemDetail.builder()
            .type("https://api.example.com/errors/validation")
            .title("Validation Failed")
            .status(HttpStatus.BAD_REQUEST.value())
            .detail("One or more fields have invalid values")
            .properties(Map.of("errors", errors))
            .build();

        return ResponseEntity.badRequest().body(problem);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ProblemDetail> handleGeneric(
            Exception ex, HttpServletRequest request) {
        log.error("Unexpected error", ex);

        ProblemDetail problem = ProblemDetail.builder()
            .type("https://api.example.com/errors/internal")
            .title("Internal Server Error")
            .status(HttpStatus.INTERNAL_SERVER_ERROR.value())
            .detail("An unexpected error occurred")
            .instance(request.getRequestURI())
            .build();

        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(problem);
    }
}
```

## Testing

### Unit Tests

```java
@ExtendWith(MockitoExtension.class)
class UserServiceTest {

    @Mock
    private UserRepository userRepository;

    @Mock
    private UserMapper userMapper;

    @InjectMocks
    private UserService userService;

    @Test
    void findById_WhenUserExists_ReturnsUser() {
        // Given
        Long userId = 1L;
        User user = User.builder().id(userId).username("john").build();
        UserDTO userDTO = UserDTO.builder().id(userId).username("john").build();

        when(userRepository.findById(userId)).thenReturn(Optional.of(user));
        when(userMapper.toDto(user)).thenReturn(userDTO);

        // When
        UserDTO result = userService.findById(userId);

        // Then
        assertThat(result).isNotNull();
        assertThat(result.getUsername()).isEqualTo("john");
        verify(userRepository).findById(userId);
    }

    @Test
    void findById_WhenUserNotExists_ThrowsException() {
        // Given
        Long userId = 1L;
        when(userRepository.findById(userId)).thenReturn(Optional.empty());

        // When/Then
        assertThatThrownBy(() -> userService.findById(userId))
            .isInstanceOf(ResourceNotFoundException.class)
            .hasMessageContaining("User not found");
    }
}
```

### Integration Tests

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@Testcontainers
class UserControllerIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:15-alpine");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private UserRepository userRepository;

    @BeforeEach
    void setUp() {
        userRepository.deleteAll();
    }

    @Test
    void createUser_WithValidData_ReturnsCreated() throws Exception {
        CreateUserDTO dto = new CreateUserDTO();
        dto.setUsername("john");
        dto.setEmail("john@example.com");
        dto.setPassword("Password123");

        mockMvc.perform(post("/api/v1/users")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.username").value("john"))
            .andExpect(jsonPath("$.email").value("john@example.com"))
            .andExpect(header().exists("Location"));
    }

    @Test
    void createUser_WithInvalidEmail_ReturnsBadRequest() throws Exception {
        CreateUserDTO dto = new CreateUserDTO();
        dto.setUsername("john");
        dto.setEmail("invalid-email");
        dto.setPassword("Password123");

        mockMvc.perform(post("/api/v1/users")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.properties.errors.email").exists());
    }
}
```

## Production Readiness

### Actuator Configuration

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  endpoint:
    health:
      show-details: when_authorized
      probes:
        enabled: true
  health:
    livenessState:
      enabled: true
    readinessState:
      enabled: true

info:
  app:
    name: ${spring.application.name}
    version: '@project.version@'
    java:
      version: ${java.version}
```

### Health Indicators

```java
@Component
public class DatabaseHealthIndicator implements HealthIndicator {

    private final DataSource dataSource;

    @Override
    public Health health() {
        try (Connection conn = dataSource.getConnection()) {
            if (conn.isValid(1)) {
                return Health.up()
                    .withDetail("database", "Available")
                    .build();
            }
        } catch (SQLException e) {
            return Health.down()
                .withDetail("database", "Unavailable")
                .withException(e)
                .build();
        }
        return Health.down().build();
    }
}
```

### Logging Configuration

```yaml
logging:
  level:
    root: INFO
    com.example.myapp: DEBUG
    org.springframework.web: INFO
    org.hibernate.SQL: DEBUG
    org.hibernate.type.descriptor.sql.BasicBinder: TRACE
  pattern:
    console: "%d{yyyy-MM-dd HH:mm:ss} [%thread] %-5level %logger{36} - %msg%n"
  file:
    name: logs/application.log
    max-size: 10MB
    max-history: 30
```

## Performance Tips

1. **Use connection pooling** - HikariCP is the default and optimal choice
2. **Enable query caching** - For read-heavy workloads
3. **Use pagination** - Never return unbounded collections
4. **Implement caching** - Use Spring Cache with Redis/Caffeine
5. **Async processing** - For I/O-bound operations
6. **Optimize JPA queries** - Use projections and EntityGraph
7. **Enable compression** - For API responses

## Security Checklist

- [ ] HTTPS only in production
- [ ] CORS properly configured
- [ ] CSRF protection (for browser clients)
- [ ] Input validation on all endpoints
- [ ] SQL injection prevention (use parameterized queries)
- [ ] Rate limiting implemented
- [ ] Sensitive data encrypted
- [ ] Security headers configured
- [ ] Dependencies scanned for vulnerabilities
- [ ] Secrets managed externally
