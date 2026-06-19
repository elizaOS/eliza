# Spring Security Reference Guide

Comprehensive guide for implementing authentication and authorization in Spring Boot applications.

## JWT Authentication

### Security Configuration

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
@RequiredArgsConstructor
public class SecurityConfig {

    private final JwtAuthenticationFilter jwtAuthFilter;
    private final AuthenticationProvider authenticationProvider;

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(AbstractHttpConfigurer::disable)
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/auth/**").permitAll()
                .requestMatchers("/api/public/**").permitAll()
                .requestMatchers("/swagger-ui/**", "/api-docs/**").permitAll()
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated()
            )
            .authenticationProvider(authenticationProvider)
            .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(List.of("http://localhost:3000"));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        config.setExposedHeaders(List.of("Authorization"));
        config.setAllowCredentials(true);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
```

### JWT Token Provider

```java
@Service
@RequiredArgsConstructor
public class JwtTokenProvider {

    @Value("${jwt.secret}")
    private String jwtSecret;

    @Value("${jwt.expiration}")
    private long jwtExpiration;

    @Value("${jwt.refresh-expiration}")
    private long refreshExpiration;

    private SecretKey getSigningKey() {
        return Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
    }

    public String generateAccessToken(UserDetails userDetails) {
        return generateToken(userDetails, jwtExpiration, TokenType.ACCESS);
    }

    public String generateRefreshToken(UserDetails userDetails) {
        return generateToken(userDetails, refreshExpiration, TokenType.REFRESH);
    }

    private String generateToken(UserDetails userDetails, long expiration, TokenType type) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("type", type.name());
        claims.put("roles", userDetails.getAuthorities().stream()
            .map(GrantedAuthority::getAuthority)
            .collect(Collectors.toList()));

        return Jwts.builder()
            .claims(claims)
            .subject(userDetails.getUsername())
            .issuedAt(new Date())
            .expiration(new Date(System.currentTimeMillis() + expiration))
            .signWith(getSigningKey())
            .compact();
    }

    public String extractUsername(String token) {
        return extractClaim(token, Claims::getSubject);
    }

    public boolean validateToken(String token, UserDetails userDetails) {
        final String username = extractUsername(token);
        return username.equals(userDetails.getUsername()) && !isTokenExpired(token);
    }

    public boolean isAccessToken(String token) {
        String type = extractClaim(token, claims -> claims.get("type", String.class));
        return TokenType.ACCESS.name().equals(type);
    }

    private boolean isTokenExpired(String token) {
        return extractExpiration(token).before(new Date());
    }

    private Date extractExpiration(String token) {
        return extractClaim(token, Claims::getExpiration);
    }

    private <T> T extractClaim(String token, Function<Claims, T> claimsResolver) {
        final Claims claims = extractAllClaims(token);
        return claimsResolver.apply(claims);
    }

    private Claims extractAllClaims(String token) {
        return Jwts.parser()
            .verifyWith(getSigningKey())
            .build()
            .parseSignedClaims(token)
            .getPayload();
    }
}
```

### Authentication Filter

```java
@Component
@RequiredArgsConstructor
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtTokenProvider tokenProvider;
    private final UserDetailsService userDetailsService;

    @Override
    protected void doFilterInternal(
            @NonNull HttpServletRequest request,
            @NonNull HttpServletResponse response,
            @NonNull FilterChain filterChain) throws ServletException, IOException {

        final String authHeader = request.getHeader("Authorization");

        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            filterChain.doFilter(request, response);
            return;
        }

        try {
            final String jwt = authHeader.substring(7);
            final String username = tokenProvider.extractUsername(jwt);

            if (username != null && SecurityContextHolder.getContext().getAuthentication() == null) {
                UserDetails userDetails = userDetailsService.loadUserByUsername(username);

                if (tokenProvider.validateToken(jwt, userDetails) && tokenProvider.isAccessToken(jwt)) {
                    UsernamePasswordAuthenticationToken authToken =
                        new UsernamePasswordAuthenticationToken(
                            userDetails,
                            null,
                            userDetails.getAuthorities()
                        );
                    authToken.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                    SecurityContextHolder.getContext().setAuthentication(authToken);
                }
            }
        } catch (JwtException e) {
            logger.error("JWT validation failed: {}", e.getMessage());
        }

        filterChain.doFilter(request, response);
    }
}
```

## OAuth2 Resource Server

```java
@Configuration
@EnableWebSecurity
public class OAuth2SecurityConfig {

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(AbstractHttpConfigurer::disable)
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/public/**").permitAll()
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter()))
            );

        return http.build();
    }

    @Bean
    public JwtAuthenticationConverter jwtAuthenticationConverter() {
        JwtGrantedAuthoritiesConverter grantedAuthoritiesConverter =
            new JwtGrantedAuthoritiesConverter();
        grantedAuthoritiesConverter.setAuthoritiesClaimName("roles");
        grantedAuthoritiesConverter.setAuthorityPrefix("ROLE_");

        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(grantedAuthoritiesConverter);
        return converter;
    }
}
```

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com
          jwk-set-uri: https://auth.example.com/.well-known/jwks.json
```

## Role-Based Access Control (RBAC)

### Role Entity

```java
@Entity
@Table(name = "roles")
public class Role {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Enumerated(EnumType.STRING)
    @Column(unique = true, nullable = false)
    private RoleName name;

    @ManyToMany(mappedBy = "roles")
    private Set<User> users = new HashSet<>();

    @ManyToMany(fetch = FetchType.EAGER)
    @JoinTable(
        name = "role_permissions",
        joinColumns = @JoinColumn(name = "role_id"),
        inverseJoinColumns = @JoinColumn(name = "permission_id")
    )
    private Set<Permission> permissions = new HashSet<>();
}

public enum RoleName {
    ROLE_USER,
    ROLE_ADMIN,
    ROLE_MANAGER,
    ROLE_MODERATOR
}
```

### User Entity with Roles

```java
@Entity
@Table(name = "users")
public class User implements UserDetails {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(unique = true, nullable = false)
    private String username;

    @Column(unique = true, nullable = false)
    private String email;

    @Column(nullable = false)
    private String password;

    private boolean enabled = true;

    @ManyToMany(fetch = FetchType.EAGER)
    @JoinTable(
        name = "user_roles",
        joinColumns = @JoinColumn(name = "user_id"),
        inverseJoinColumns = @JoinColumn(name = "role_id")
    )
    private Set<Role> roles = new HashSet<>();

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        Set<GrantedAuthority> authorities = new HashSet<>();

        for (Role role : roles) {
            authorities.add(new SimpleGrantedAuthority(role.getName().name()));
            role.getPermissions().forEach(permission ->
                authorities.add(new SimpleGrantedAuthority(permission.getName()))
            );
        }

        return authorities;
    }

    @Override
    public boolean isAccountNonExpired() { return true; }

    @Override
    public boolean isAccountNonLocked() { return true; }

    @Override
    public boolean isCredentialsNonExpired() { return true; }

    @Override
    public boolean isEnabled() { return enabled; }
}
```

## Method Security

### @PreAuthorize Examples

```java
@Service
@RequiredArgsConstructor
public class UserService {

    // Role-based access
    @PreAuthorize("hasRole('ADMIN')")
    public void deleteUser(Long userId) {
        userRepository.deleteById(userId);
    }

    // Multiple roles
    @PreAuthorize("hasAnyRole('ADMIN', 'MANAGER')")
    public List<User> getAllUsers() {
        return userRepository.findAll();
    }

    // Permission-based access
    @PreAuthorize("hasAuthority('USER_READ')")
    public User getUser(Long userId) {
        return userRepository.findById(userId).orElseThrow();
    }

    // SpEL expression with method arguments
    @PreAuthorize("#userId == authentication.principal.id or hasRole('ADMIN')")
    public User updateUser(Long userId, UpdateUserDTO dto) {
        User user = userRepository.findById(userId).orElseThrow();
        // Update logic
        return user;
    }

    // Custom security expression
    @PreAuthorize("@userSecurity.canAccessUser(#userId)")
    public UserDetails getUserDetails(Long userId) {
        return userRepository.findById(userId).orElseThrow();
    }
}

// Custom security service
@Service("userSecurity")
@RequiredArgsConstructor
public class UserSecurityService {

    public boolean canAccessUser(Long userId) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        User currentUser = (User) auth.getPrincipal();

        // Check if current user owns this resource or is admin
        return currentUser.getId().equals(userId) ||
               auth.getAuthorities().stream()
                   .anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN"));
    }
}
```

### @PostAuthorize for Response Filtering

```java
@PostAuthorize("returnObject.owner.id == authentication.principal.id or hasRole('ADMIN')")
public Document getDocument(Long documentId) {
    return documentRepository.findById(documentId).orElseThrow();
}

@PostFilter("filterObject.department == authentication.principal.department or hasRole('ADMIN')")
public List<Employee> getEmployees() {
    return employeeRepository.findAll();
}
```

## Security Testing

```java
@SpringBootTest
@AutoConfigureMockMvc
class SecurityIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void publicEndpoint_ShouldBeAccessible() throws Exception {
        mockMvc.perform(get("/api/public/health"))
            .andExpect(status().isOk());
    }

    @Test
    void protectedEndpoint_WithoutAuth_ShouldReturn401() throws Exception {
        mockMvc.perform(get("/api/users"))
            .andExpect(status().isUnauthorized());
    }

    @Test
    @WithMockUser(roles = "USER")
    void protectedEndpoint_WithUser_ShouldBeAccessible() throws Exception {
        mockMvc.perform(get("/api/users/me"))
            .andExpect(status().isOk());
    }

    @Test
    @WithMockUser(roles = "ADMIN")
    void adminEndpoint_WithAdmin_ShouldBeAccessible() throws Exception {
        mockMvc.perform(get("/api/admin/users"))
            .andExpect(status().isOk());
    }

    @Test
    @WithMockUser(roles = "USER")
    void adminEndpoint_WithUser_ShouldReturn403() throws Exception {
        mockMvc.perform(get("/api/admin/users"))
            .andExpect(status().isForbidden());
    }

    @Test
    void loginEndpoint_WithValidCredentials_ShouldReturnToken() throws Exception {
        mockMvc.perform(post("/api/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {"username": "testuser", "password": "password123"}
                    """))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.accessToken").exists())
            .andExpect(jsonPath("$.refreshToken").exists());
    }
}
```

## Security Best Practices Checklist

- [ ] Use HTTPS in production
- [ ] Store passwords with bcrypt (strength 12+)
- [ ] Implement rate limiting for auth endpoints
- [ ] Use short-lived access tokens (15-60 min)
- [ ] Implement token refresh mechanism
- [ ] Validate and sanitize all input
- [ ] Use CSRF protection for browser clients
- [ ] Configure secure headers (CSP, X-Frame-Options)
- [ ] Implement account lockout after failed attempts
- [ ] Log security events (login, logout, failures)
- [ ] Rotate secrets and keys regularly
- [ ] Use environment variables for secrets
