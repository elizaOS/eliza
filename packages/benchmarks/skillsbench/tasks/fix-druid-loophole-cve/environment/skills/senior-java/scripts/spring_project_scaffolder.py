#!/usr/bin/env python3
"""
Spring Boot Project Scaffolder
Generate production-ready Spring Boot project structures with complete configuration.

Features:
- Spring Boot 3.x with Java 17/21 support
- Multiple project types (microservice, monolith, reactive)
- Database configuration (PostgreSQL, MySQL, MongoDB, H2)
- Docker and Docker Compose setup
- GitHub Actions CI/CD pipeline
- Layered architecture (controller, service, repository)
- Lombok and MapStruct integration

Standard library only - no external dependencies required.
"""

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

__version__ = "1.0.0"


@dataclass
class ProjectConfig:
    """Configuration for the Spring Boot project"""
    name: str
    project_type: str  # microservice, monolith, reactive
    database: str = "postgresql"  # postgresql, mysql, mongodb, h2
    security: Optional[str] = None  # jwt, oauth2, basic, None
    java_version: int = 17
    spring_boot_version: str = "3.2.0"
    include_docker: bool = True
    include_ci: bool = True
    group_id: str = "com.example"
    package_name: str = ""

    def __post_init__(self):
        if not self.package_name:
            self.package_name = f"{self.group_id}.{self.name.replace('-', '')}"


class SpringProjectScaffolder:
    """
    Spring Boot project scaffolding tool for generating production-ready Java applications.
    """

    def __init__(self, config: ProjectConfig, output_dir: str, verbose: bool = False):
        if verbose:
            logging.getLogger().setLevel(logging.DEBUG)
        logger.debug("SpringProjectScaffolder initialized")

        self.config = config
        self.output_dir = Path(output_dir) / config.name
        self.verbose = verbose
        self.files_created: List[str] = []

    def scaffold(self) -> Dict[str, Any]:
        """Generate the complete project structure"""
        logger.debug(f"Scaffolding {self.config.project_type} Spring Boot project: {self.config.name}")
        if self.verbose:
            print(f"Scaffolding Spring Boot {self.config.project_type}: {self.config.name}")
            print(f"Java Version: {self.config.java_version}")
            print(f"Database: {self.config.database}")
            print(f"Security: {self.config.security or 'None'}")
            print(f"Output: {self.output_dir}\n")

        # Create project directory
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Generate base structure
        self._create_directory_structure()
        self._create_pom_xml()
        self._create_application_properties()
        self._create_main_class()

        # Generate source code structure
        self._create_config_classes()
        self._create_exception_handling()

        # Generate security if enabled
        if self.config.security:
            self._create_security_config()

        # Generate infrastructure files
        if self.config.include_docker:
            self._create_docker_files()

        if self.config.include_ci:
            self._create_github_actions()

        return self._generate_report()

    def _create_directory_structure(self):
        """Create the Maven project directory structure"""
        package_path = self.config.package_name.replace('.', '/')

        directories = [
            f"src/main/java/{package_path}",
            f"src/main/java/{package_path}/config",
            f"src/main/java/{package_path}/controller",
            f"src/main/java/{package_path}/service",
            f"src/main/java/{package_path}/repository",
            f"src/main/java/{package_path}/entity",
            f"src/main/java/{package_path}/dto",
            f"src/main/java/{package_path}/mapper",
            f"src/main/java/{package_path}/exception",
            "src/main/resources",
            "src/main/resources/db/migration",
            f"src/test/java/{package_path}",
            f"src/test/java/{package_path}/controller",
            f"src/test/java/{package_path}/service",
            "src/test/resources",
        ]

        if self.config.security:
            directories.append(f"src/main/java/{package_path}/security")

        for directory in directories:
            dir_path = self.output_dir / directory
            dir_path.mkdir(parents=True, exist_ok=True)
            logger.debug(f"Created directory: {directory}")

    def _create_pom_xml(self):
        """Generate Maven pom.xml"""
        dependencies = self._get_dependencies()

        pom_content = f'''<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
         https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>{self.config.spring_boot_version}</version>
        <relativePath/>
    </parent>

    <groupId>{self.config.group_id}</groupId>
    <artifactId>{self.config.name}</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>{self.config.name}</name>
    <description>Spring Boot {self.config.project_type} application</description>

    <properties>
        <java.version>{self.config.java_version}</java.version>
        <mapstruct.version>1.5.5.Final</mapstruct.version>
    </properties>

    <dependencies>
{dependencies}
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <configuration>
                    <excludes>
                        <exclude>
                            <groupId>org.projectlombok</groupId>
                            <artifactId>lombok</artifactId>
                        </exclude>
                    </excludes>
                </configuration>
            </plugin>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <configuration>
                    <annotationProcessorPaths>
                        <path>
                            <groupId>org.projectlombok</groupId>
                            <artifactId>lombok</artifactId>
                            <version>1.18.30</version>
                        </path>
                        <path>
                            <groupId>org.mapstruct</groupId>
                            <artifactId>mapstruct-processor</artifactId>
                            <version>${{mapstruct.version}}</version>
                        </path>
                        <path>
                            <groupId>org.projectlombok</groupId>
                            <artifactId>lombok-mapstruct-binding</artifactId>
                            <version>0.2.0</version>
                        </path>
                    </annotationProcessorPaths>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
'''
        self._write_file("pom.xml", pom_content)

    def _get_dependencies(self) -> str:
        """Get Maven dependencies based on configuration"""
        deps = []

        # Core dependencies
        if self.config.project_type == "reactive":
            deps.append(('org.springframework.boot', 'spring-boot-starter-webflux'))
        else:
            deps.append(('org.springframework.boot', 'spring-boot-starter-web'))

        deps.append(('org.springframework.boot', 'spring-boot-starter-validation'))
        deps.append(('org.springframework.boot', 'spring-boot-starter-actuator'))

        # Database dependencies
        if self.config.database == "postgresql":
            deps.append(('org.springframework.boot', 'spring-boot-starter-data-jpa'))
            deps.append(('org.postgresql', 'postgresql', 'runtime'))
        elif self.config.database == "mysql":
            deps.append(('org.springframework.boot', 'spring-boot-starter-data-jpa'))
            deps.append(('com.mysql', 'mysql-connector-j', 'runtime'))
        elif self.config.database == "mongodb":
            if self.config.project_type == "reactive":
                deps.append(('org.springframework.boot', 'spring-boot-starter-data-mongodb-reactive'))
            else:
                deps.append(('org.springframework.boot', 'spring-boot-starter-data-mongodb'))
        elif self.config.database == "h2":
            deps.append(('org.springframework.boot', 'spring-boot-starter-data-jpa'))
            deps.append(('com.h2database', 'h2', 'runtime'))

        # Security dependencies
        if self.config.security:
            deps.append(('org.springframework.boot', 'spring-boot-starter-security'))
            if self.config.security == "oauth2":
                deps.append(('org.springframework.boot', 'spring-boot-starter-oauth2-resource-server'))
            elif self.config.security == "jwt":
                deps.append(('io.jsonwebtoken', 'jjwt-api', None, '0.12.3'))
                deps.append(('io.jsonwebtoken', 'jjwt-impl', 'runtime', '0.12.3'))
                deps.append(('io.jsonwebtoken', 'jjwt-jackson', 'runtime', '0.12.3'))

        # Utility dependencies
        deps.append(('org.projectlombok', 'lombok', 'provided'))
        deps.append(('org.mapstruct', 'mapstruct', None, '${mapstruct.version}'))

        # OpenAPI documentation
        deps.append(('org.springdoc', 'springdoc-openapi-starter-webmvc-ui', None, '2.3.0'))

        # Test dependencies
        deps.append(('org.springframework.boot', 'spring-boot-starter-test', 'test'))
        if self.config.security:
            deps.append(('org.springframework.security', 'spring-security-test', 'test'))

        # Format dependencies as XML
        xml_deps = []
        for dep in deps:
            if len(dep) == 2:
                group_id, artifact_id = dep
                xml_deps.append(f'''        <dependency>
            <groupId>{group_id}</groupId>
            <artifactId>{artifact_id}</artifactId>
        </dependency>''')
            elif len(dep) == 3:
                group_id, artifact_id, scope = dep
                scope_xml = f"\n            <scope>{scope}</scope>" if scope else ""
                xml_deps.append(f'''        <dependency>
            <groupId>{group_id}</groupId>
            <artifactId>{artifact_id}</artifactId>{scope_xml}
        </dependency>''')
            elif len(dep) == 4:
                group_id, artifact_id, scope, version = dep
                scope_xml = f"\n            <scope>{scope}</scope>" if scope else ""
                version_xml = f"\n            <version>{version}</version>" if version else ""
                xml_deps.append(f'''        <dependency>
            <groupId>{group_id}</groupId>
            <artifactId>{artifact_id}</artifactId>{version_xml}{scope_xml}
        </dependency>''')

        return '\n'.join(xml_deps)

    def _create_application_properties(self):
        """Generate application.yml configuration"""
        db_config = self._get_database_config()

        content = f'''spring:
  application:
    name: {self.config.name}
  profiles:
    active: dev

---
spring:
  config:
    activate:
      on-profile: dev
{db_config}
  jpa:
    hibernate:
      ddl-auto: update
    show-sql: true
    properties:
      hibernate:
        format_sql: true

server:
  port: 8080

logging:
  level:
    root: INFO
    {self.config.package_name}: DEBUG
    org.hibernate.SQL: DEBUG

springdoc:
  api-docs:
    path: /api-docs
  swagger-ui:
    path: /swagger-ui.html

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  endpoint:
    health:
      show-details: always

---
spring:
  config:
    activate:
      on-profile: prod
{db_config}
  jpa:
    hibernate:
      ddl-auto: validate
    show-sql: false

server:
  port: 8080

logging:
  level:
    root: WARN
    {self.config.package_name}: INFO
'''

        if self.config.security == "jwt":
            content += f'''
jwt:
  secret: ${{JWT_SECRET:your-256-bit-secret-key-here-change-in-production}}
  expiration: 86400000  # 24 hours
  refresh-expiration: 604800000  # 7 days
'''

        self._write_file("src/main/resources/application.yml", content)

    def _get_database_config(self) -> str:
        """Get database-specific configuration"""
        if self.config.database == "postgresql":
            return '''  datasource:
    url: jdbc:postgresql://localhost:5432/{}
    username: ${{DB_USERNAME:postgres}}
    password: ${{DB_PASSWORD:postgres}}
    driver-class-name: org.postgresql.Driver'''.format(self.config.name.replace('-', '_'))
        elif self.config.database == "mysql":
            return '''  datasource:
    url: jdbc:mysql://localhost:3306/{}
    username: ${{DB_USERNAME:root}}
    password: ${{DB_PASSWORD:root}}
    driver-class-name: com.mysql.cj.jdbc.Driver'''.format(self.config.name.replace('-', '_'))
        elif self.config.database == "mongodb":
            return '''  data:
    mongodb:
      uri: mongodb://localhost:27017/{}'''.format(self.config.name.replace('-', '_'))
        elif self.config.database == "h2":
            return '''  datasource:
    url: jdbc:h2:mem:testdb
    driver-class-name: org.h2.Driver
    username: sa
    password:
  h2:
    console:
      enabled: true'''
        return ""

    def _create_main_class(self):
        """Generate main application class"""
        package_path = self.config.package_name.replace('.', '/')
        class_name = ''.join(word.capitalize() for word in self.config.name.split('-')) + "Application"

        content = f'''package {self.config.package_name};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class {class_name} {{

    public static void main(String[] args) {{
        SpringApplication.run({class_name}.class, args);
    }}
}}
'''
        self._write_file(f"src/main/java/{package_path}/{class_name}.java", content)

    def _create_config_classes(self):
        """Generate configuration classes"""
        package_path = self.config.package_name.replace('.', '/')

        # OpenAPI config
        openapi_config = f'''package {self.config.package_name}.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.info.Contact;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {{

    @Bean
    public OpenAPI customOpenAPI() {{
        return new OpenAPI()
            .info(new Info()
                .title("{self.config.name} API")
                .version("1.0.0")
                .description("API documentation for {self.config.name}")
                .contact(new Contact()
                    .name("API Support")
                    .email("support@example.com")));
    }}
}}
'''
        self._write_file(f"src/main/java/{package_path}/config/OpenApiConfig.java", openapi_config)

    def _create_exception_handling(self):
        """Generate global exception handler"""
        package_path = self.config.package_name.replace('.', '/')

        # Custom exception
        not_found = f'''package {self.config.package_name}.exception;

public class ResourceNotFoundException extends RuntimeException {{

    public ResourceNotFoundException(String message) {{
        super(message);
    }}

    public ResourceNotFoundException(String resourceName, String fieldName, Object fieldValue) {{
        super(String.format("%s not found with %s: '%s'", resourceName, fieldName, fieldValue));
    }}
}}
'''
        self._write_file(f"src/main/java/{package_path}/exception/ResourceNotFoundException.java", not_found)

        # Error response DTO
        error_response = f'''package {self.config.package_name}.exception;

import com.fasterxml.jackson.annotation.JsonFormat;
import lombok.Builder;
import lombok.Data;

import java.time.LocalDateTime;
import java.util.List;

@Data
@Builder
public class ErrorResponse {{

    @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd HH:mm:ss")
    private LocalDateTime timestamp;

    private int status;
    private String error;
    private String message;
    private String path;
    private List<FieldError> fieldErrors;

    @Data
    @Builder
    public static class FieldError {{
        private String field;
        private String message;
    }}
}}
'''
        self._write_file(f"src/main/java/{package_path}/exception/ErrorResponse.java", error_response)

        # Global exception handler
        handler = f'''package {self.config.package_name}.exception;

import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.BindingResult;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.time.LocalDateTime;
import java.util.List;
import java.util.stream.Collectors;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {{

    @ExceptionHandler(ResourceNotFoundException.class)
    public ResponseEntity<ErrorResponse> handleResourceNotFound(
            ResourceNotFoundException ex, HttpServletRequest request) {{
        log.error("Resource not found: {{}}", ex.getMessage());

        ErrorResponse error = ErrorResponse.builder()
            .timestamp(LocalDateTime.now())
            .status(HttpStatus.NOT_FOUND.value())
            .error(HttpStatus.NOT_FOUND.getReasonPhrase())
            .message(ex.getMessage())
            .path(request.getRequestURI())
            .build();

        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(error);
    }}

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidationErrors(
            MethodArgumentNotValidException ex, HttpServletRequest request) {{
        log.error("Validation error: {{}}", ex.getMessage());

        BindingResult result = ex.getBindingResult();
        List<ErrorResponse.FieldError> fieldErrors = result.getFieldErrors().stream()
            .map(error -> ErrorResponse.FieldError.builder()
                .field(error.getField())
                .message(error.getDefaultMessage())
                .build())
            .collect(Collectors.toList());

        ErrorResponse error = ErrorResponse.builder()
            .timestamp(LocalDateTime.now())
            .status(HttpStatus.BAD_REQUEST.value())
            .error(HttpStatus.BAD_REQUEST.getReasonPhrase())
            .message("Validation failed")
            .path(request.getRequestURI())
            .fieldErrors(fieldErrors)
            .build();

        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(error);
    }}

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleGenericException(
            Exception ex, HttpServletRequest request) {{
        log.error("Unexpected error: {{}}", ex.getMessage(), ex);

        ErrorResponse error = ErrorResponse.builder()
            .timestamp(LocalDateTime.now())
            .status(HttpStatus.INTERNAL_SERVER_ERROR.value())
            .error(HttpStatus.INTERNAL_SERVER_ERROR.getReasonPhrase())
            .message("An unexpected error occurred")
            .path(request.getRequestURI())
            .build();

        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error);
    }}
}}
'''
        self._write_file(f"src/main/java/{package_path}/exception/GlobalExceptionHandler.java", handler)

    def _create_security_config(self):
        """Generate Spring Security configuration"""
        package_path = self.config.package_name.replace('.', '/')

        if self.config.security == "jwt":
            security_config = f'''package {self.config.package_name}.security;

import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@EnableWebSecurity
@EnableMethodSecurity
@RequiredArgsConstructor
public class SecurityConfig {{

    private final JwtAuthenticationFilter jwtAuthenticationFilter;

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {{
        http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/auth/**").permitAll()
                .requestMatchers("/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                .requestMatchers("/actuator/**").permitAll()
                .anyRequest().authenticated()
            )
            .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }}

    @Bean
    public PasswordEncoder passwordEncoder() {{
        return new BCryptPasswordEncoder();
    }}

    @Bean
    public AuthenticationManager authenticationManager(AuthenticationConfiguration config) throws Exception {{
        return config.getAuthenticationManager();
    }}
}}
'''
            self._write_file(f"src/main/java/{package_path}/security/SecurityConfig.java", security_config)

            # JWT Authentication Filter
            jwt_filter = f'''package {self.config.package_name}.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

@Slf4j
@Component
@RequiredArgsConstructor
public class JwtAuthenticationFilter extends OncePerRequestFilter {{

    private final JwtTokenProvider tokenProvider;
    private final UserDetailsService userDetailsService;

    @Override
    protected void doFilterInternal(
            @NonNull HttpServletRequest request,
            @NonNull HttpServletResponse response,
            @NonNull FilterChain filterChain) throws ServletException, IOException {{

        try {{
            String jwt = getJwtFromRequest(request);

            if (StringUtils.hasText(jwt) && tokenProvider.validateToken(jwt)) {{
                String username = tokenProvider.getUsernameFromToken(jwt);
                UserDetails userDetails = userDetailsService.loadUserByUsername(username);

                UsernamePasswordAuthenticationToken authentication =
                    new UsernamePasswordAuthenticationToken(
                        userDetails, null, userDetails.getAuthorities());
                authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));

                SecurityContextHolder.getContext().setAuthentication(authentication);
            }}
        }} catch (Exception ex) {{
            log.error("Could not set user authentication in security context", ex);
        }}

        filterChain.doFilter(request, response);
    }}

    private String getJwtFromRequest(HttpServletRequest request) {{
        String bearerToken = request.getHeader("Authorization");
        if (StringUtils.hasText(bearerToken) && bearerToken.startsWith("Bearer ")) {{
            return bearerToken.substring(7);
        }}
        return null;
    }}
}}
'''
            self._write_file(f"src/main/java/{package_path}/security/JwtAuthenticationFilter.java", jwt_filter)

            # JWT Token Provider
            jwt_provider = f'''package {self.config.package_name}.security;

import io.jsonwebtoken.*;
import io.jsonwebtoken.security.Keys;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;

@Slf4j
@Component
public class JwtTokenProvider {{

    @Value("${{jwt.secret}}")
    private String jwtSecret;

    @Value("${{jwt.expiration}}")
    private long jwtExpiration;

    @Value("${{jwt.refresh-expiration}}")
    private long jwtRefreshExpiration;

    private SecretKey getSigningKey() {{
        return Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
    }}

    public String generateToken(Authentication authentication) {{
        UserDetails userDetails = (UserDetails) authentication.getPrincipal();
        Date now = new Date();
        Date expiryDate = new Date(now.getTime() + jwtExpiration);

        return Jwts.builder()
            .subject(userDetails.getUsername())
            .issuedAt(now)
            .expiration(expiryDate)
            .signWith(getSigningKey())
            .compact();
    }}

    public String generateRefreshToken(Authentication authentication) {{
        UserDetails userDetails = (UserDetails) authentication.getPrincipal();
        Date now = new Date();
        Date expiryDate = new Date(now.getTime() + jwtRefreshExpiration);

        return Jwts.builder()
            .subject(userDetails.getUsername())
            .issuedAt(now)
            .expiration(expiryDate)
            .signWith(getSigningKey())
            .compact();
    }}

    public String getUsernameFromToken(String token) {{
        Claims claims = Jwts.parser()
            .verifyWith(getSigningKey())
            .build()
            .parseSignedClaims(token)
            .getPayload();

        return claims.getSubject();
    }}

    public boolean validateToken(String token) {{
        try {{
            Jwts.parser()
                .verifyWith(getSigningKey())
                .build()
                .parseSignedClaims(token);
            return true;
        }} catch (MalformedJwtException ex) {{
            log.error("Invalid JWT token");
        }} catch (ExpiredJwtException ex) {{
            log.error("Expired JWT token");
        }} catch (UnsupportedJwtException ex) {{
            log.error("Unsupported JWT token");
        }} catch (IllegalArgumentException ex) {{
            log.error("JWT claims string is empty");
        }}
        return false;
    }}
}}
'''
            self._write_file(f"src/main/java/{package_path}/security/JwtTokenProvider.java", jwt_provider)

    def _create_docker_files(self):
        """Generate Docker and Docker Compose files"""
        dockerfile = f'''FROM eclipse-temurin:{self.config.java_version}-jdk-alpine as build
WORKDIR /app
COPY mvnw .
COPY .mvn .mvn
COPY pom.xml .
COPY src src
RUN chmod +x ./mvnw
RUN ./mvnw clean package -DskipTests

FROM eclipse-temurin:{self.config.java_version}-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
'''
        self._write_file("Dockerfile", dockerfile)

        # Docker Compose
        db_service = self._get_docker_db_service()
        compose = f'''version: '3.8'

services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      - SPRING_PROFILES_ACTIVE=dev
{self._get_docker_env_vars()}
    depends_on:
      - db
    networks:
      - app-network

{db_service}

networks:
  app-network:
    driver: bridge

volumes:
  db-data:
'''
        self._write_file("docker-compose.yml", compose)

    def _get_docker_db_service(self) -> str:
        """Get Docker Compose database service configuration"""
        if self.config.database == "postgresql":
            return '''  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: {}
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - db-data:/var/lib/postgresql/data
    networks:
      - app-network'''.format(self.config.name.replace('-', '_'))
        elif self.config.database == "mysql":
            return '''  db:
    image: mysql:8
    environment:
      MYSQL_DATABASE: {}
      MYSQL_ROOT_PASSWORD: root
    ports:
      - "3306:3306"
    volumes:
      - db-data:/var/lib/mysql
    networks:
      - app-network'''.format(self.config.name.replace('-', '_'))
        elif self.config.database == "mongodb":
            return '''  db:
    image: mongo:6
    ports:
      - "27017:27017"
    volumes:
      - db-data:/data/db
    networks:
      - app-network'''
        return ""

    def _get_docker_env_vars(self) -> str:
        """Get Docker environment variables"""
        if self.config.database == "postgresql":
            return '''      - DB_USERNAME=postgres
      - DB_PASSWORD=postgres
      - SPRING_DATASOURCE_URL=jdbc:postgresql://db:5432/{}'''.format(self.config.name.replace('-', '_'))
        elif self.config.database == "mysql":
            return '''      - DB_USERNAME=root
      - DB_PASSWORD=root
      - SPRING_DATASOURCE_URL=jdbc:mysql://db:3306/{}'''.format(self.config.name.replace('-', '_'))
        elif self.config.database == "mongodb":
            return '''      - SPRING_DATA_MONGODB_URI=mongodb://db:27017/{}'''.format(self.config.name.replace('-', '_'))
        return ""

    def _create_github_actions(self):
        """Generate GitHub Actions CI/CD workflow"""
        workflow = f'''name: CI/CD Pipeline

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v4

    - name: Set up JDK {self.config.java_version}
      uses: actions/setup-java@v4
      with:
        java-version: '{self.config.java_version}'
        distribution: 'temurin'
        cache: maven

    - name: Build with Maven
      run: mvn -B package --file pom.xml

    - name: Run tests
      run: mvn test

    - name: Upload coverage to Codecov
      uses: codecov/codecov-action@v3
      with:
        file: ./target/site/jacoco/jacoco.xml

  docker:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'

    steps:
    - uses: actions/checkout@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Login to Docker Hub
      uses: docker/login-action@v3
      with:
        username: ${{{{ secrets.DOCKERHUB_USERNAME }}}}
        password: ${{{{ secrets.DOCKERHUB_TOKEN }}}}

    - name: Build and push
      uses: docker/build-push-action@v5
      with:
        context: .
        push: true
        tags: ${{{{ secrets.DOCKERHUB_USERNAME }}}}/{self.config.name}:latest
'''

        workflow_dir = self.output_dir / ".github" / "workflows"
        workflow_dir.mkdir(parents=True, exist_ok=True)
        self._write_file(".github/workflows/ci-cd.yml", workflow)

    def _write_file(self, path: str, content: str):
        """Write content to a file"""
        file_path = self.output_dir / path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content)
        self.files_created.append(path)
        logger.debug(f"Created file: {path}")

    def _generate_report(self) -> Dict[str, Any]:
        """Generate a summary report of the scaffolded project"""
        return {
            "project_name": self.config.name,
            "project_type": self.config.project_type,
            "java_version": self.config.java_version,
            "spring_boot_version": self.config.spring_boot_version,
            "database": self.config.database,
            "security": self.config.security,
            "output_directory": str(self.output_dir),
            "files_created": len(self.files_created),
            "includes": {
                "docker": self.config.include_docker,
                "ci_cd": self.config.include_ci,
            }
        }


def main():
    """CLI entry point"""
    parser = argparse.ArgumentParser(
        description="Spring Boot Project Scaffolder - Generate production-ready Spring Boot projects",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Create microservice with PostgreSQL and JWT security
  python spring_project_scaffolder.py user-service --type microservice --db postgresql --security jwt

  # Create monolith with MySQL
  python spring_project_scaffolder.py ecommerce --type monolith --db mysql

  # Create reactive service with MongoDB
  python spring_project_scaffolder.py notification-service --type reactive --db mongodb

  # Minimal project without Docker/CI
  python spring_project_scaffolder.py simple-api --no-docker --no-ci
"""
    )

    parser.add_argument("name", help="Project name (kebab-case)")
    parser.add_argument("--type", dest="project_type",
                        choices=["microservice", "monolith", "reactive"],
                        default="microservice",
                        help="Project type (default: microservice)")
    parser.add_argument("--db", dest="database",
                        choices=["postgresql", "mysql", "mongodb", "h2"],
                        default="postgresql",
                        help="Database type (default: postgresql)")
    parser.add_argument("--security",
                        choices=["jwt", "oauth2", "basic"],
                        help="Security type (optional)")
    parser.add_argument("--java", dest="java_version",
                        type=int, choices=[17, 21],
                        default=17,
                        help="Java version (default: 17)")
    parser.add_argument("--group-id",
                        default="com.example",
                        help="Maven group ID (default: com.example)")
    parser.add_argument("--output", "-o",
                        default=".",
                        help="Output directory (default: current directory)")
    parser.add_argument("--no-docker", action="store_true",
                        help="Skip Docker configuration")
    parser.add_argument("--no-ci", action="store_true",
                        help="Skip CI/CD configuration")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable verbose output")
    parser.add_argument("--json", action="store_true",
                        help="Output result as JSON")
    parser.add_argument("--version", action="version",
                        version=f"%(prog)s {__version__}")

    args = parser.parse_args()

    config = ProjectConfig(
        name=args.name,
        project_type=args.project_type,
        database=args.database,
        security=args.security,
        java_version=args.java_version,
        group_id=args.group_id,
        include_docker=not args.no_docker,
        include_ci=not args.no_ci,
    )

    scaffolder = SpringProjectScaffolder(config, args.output, args.verbose)
    result = scaffolder.scaffold()

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"\n{'='*60}")
        print(f"Project '{result['project_name']}' created successfully!")
        print(f"{'='*60}")
        print(f"Location: {result['output_directory']}")
        print(f"Files created: {result['files_created']}")
        print(f"\nNext steps:")
        print(f"  cd {args.name}")
        print(f"  docker-compose up -d  # Start database")
        print(f"  ./mvnw spring-boot:run  # Start application")
        print(f"\nAPI available at: http://localhost:8080")
        print(f"Swagger UI: http://localhost:8080/swagger-ui.html")


if __name__ == "__main__":
    main()
