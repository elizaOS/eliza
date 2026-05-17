#!/usr/bin/env python3
"""
Spring Security Configuration Generator
Generate Spring Security configuration for various authentication methods.

Features:
- JWT authentication setup
- OAuth2 resource server configuration
- Role-based access control
- Method security configuration
- CORS and CSRF configuration
- Security filter chain

Standard library only - no external dependencies required.
"""

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

__version__ = "1.0.0"


def generate_jwt_config(roles: List[str], package: str) -> Dict[str, str]:
    """Generate JWT security configuration files"""
    files = {}

    roles_enum = "\n".join([f"    {r}," for r in roles])

    # Role enum
    files["Role.java"] = f'''package {package}.security;

public enum Role {{
{roles_enum}
}}
'''

    # Security Config
    files["SecurityConfig.java"] = f'''package {package}.security;

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
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.Arrays;
import java.util.List;

@Configuration
@EnableWebSecurity
@EnableMethodSecurity
@RequiredArgsConstructor
public class SecurityConfig {{

    private final JwtAuthenticationFilter jwtAuthenticationFilter;
    private final JwtAuthenticationEntryPoint jwtAuthenticationEntryPoint;

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {{
        http
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .csrf(csrf -> csrf.disable())
            .exceptionHandling(ex -> ex.authenticationEntryPoint(jwtAuthenticationEntryPoint))
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/auth/**").permitAll()
                .requestMatchers("/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                .anyRequest().authenticated()
            )
            .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }}

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {{
        CorsConfiguration configuration = new CorsConfiguration();
        configuration.setAllowedOrigins(List.of("http://localhost:3000", "http://localhost:8080"));
        configuration.setAllowedMethods(Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        configuration.setAllowedHeaders(Arrays.asList("Authorization", "Content-Type", "X-Requested-With"));
        configuration.setExposedHeaders(List.of("Authorization"));
        configuration.setAllowCredentials(true);
        configuration.setMaxAge(3600L);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", configuration);
        return source;
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

    # JWT Authentication Entry Point
    files["JwtAuthenticationEntryPoint.java"] = f'''package {package}.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;

@Component
@RequiredArgsConstructor
public class JwtAuthenticationEntryPoint implements AuthenticationEntryPoint {{

    private final ObjectMapper objectMapper;

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response,
                         AuthenticationException authException) throws IOException {{
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);

        Map<String, Object> body = new HashMap<>();
        body.put("timestamp", LocalDateTime.now().toString());
        body.put("status", HttpServletResponse.SC_UNAUTHORIZED);
        body.put("error", "Unauthorized");
        body.put("message", authException.getMessage());
        body.put("path", request.getServletPath());

        objectMapper.writeValue(response.getOutputStream(), body);
    }}
}}
'''

    # Auth Controller
    files["AuthController.java"] = f'''package {package}.controller;

import {package}.dto.AuthRequest;
import {package}.dto.AuthResponse;
import {package}.dto.RegisterRequest;
import {package}.service.AuthService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
@Tag(name = "Authentication", description = "Authentication APIs")
public class AuthController {{

    private final AuthService authService;

    @PostMapping("/login")
    @Operation(summary = "Authenticate user and get JWT token")
    public ResponseEntity<AuthResponse> login(@Valid @RequestBody AuthRequest request) {{
        return ResponseEntity.ok(authService.authenticate(request));
    }}

    @PostMapping("/register")
    @Operation(summary = "Register a new user")
    public ResponseEntity<AuthResponse> register(@Valid @RequestBody RegisterRequest request) {{
        return ResponseEntity.ok(authService.register(request));
    }}

    @PostMapping("/refresh")
    @Operation(summary = "Refresh JWT token")
    public ResponseEntity<AuthResponse> refresh(@RequestHeader("Authorization") String refreshToken) {{
        return ResponseEntity.ok(authService.refresh(refreshToken));
    }}
}}
'''

    # Auth DTOs
    files["AuthRequest.java"] = f'''package {package}.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class AuthRequest {{
    @NotBlank(message = "Username is required")
    private String username;

    @NotBlank(message = "Password is required")
    private String password;
}}
'''

    files["RegisterRequest.java"] = f'''package {package}.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class RegisterRequest {{
    @NotBlank(message = "Username is required")
    @Size(min = 3, max = 50, message = "Username must be between 3 and 50 characters")
    private String username;

    @NotBlank(message = "Email is required")
    @Email(message = "Email must be valid")
    private String email;

    @NotBlank(message = "Password is required")
    @Size(min = 8, message = "Password must be at least 8 characters")
    private String password;
}}
'''

    files["AuthResponse.java"] = f'''package {package}.dto;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class AuthResponse {{
    private String accessToken;
    private String refreshToken;
    private String tokenType;
    private Long expiresIn;
}}
'''

    return files


def generate_oauth2_config(issuer_uri: str, package: str) -> Dict[str, str]:
    """Generate OAuth2 resource server configuration"""
    files = {}

    files["SecurityConfig.java"] = f'''package {package}.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.oauth2.server.resource.authentication.JwtGrantedAuthoritiesConverter;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {{

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {{
        http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api-docs/**", "/swagger-ui/**").permitAll()
                .requestMatchers("/actuator/health").permitAll()
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter()))
            );

        return http.build();
    }}

    @Bean
    public JwtAuthenticationConverter jwtAuthenticationConverter() {{
        JwtGrantedAuthoritiesConverter grantedAuthoritiesConverter = new JwtGrantedAuthoritiesConverter();
        grantedAuthoritiesConverter.setAuthoritiesClaimName("roles");
        grantedAuthoritiesConverter.setAuthorityPrefix("ROLE_");

        JwtAuthenticationConverter jwtAuthenticationConverter = new JwtAuthenticationConverter();
        jwtAuthenticationConverter.setJwtGrantedAuthoritiesConverter(grantedAuthoritiesConverter);
        return jwtAuthenticationConverter;
    }}
}}
'''

    files["application-security.yml"] = f'''spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: {issuer_uri}
          # jwk-set-uri: {issuer_uri}/.well-known/jwks.json
'''

    return files


def main():
    parser = argparse.ArgumentParser(
        description="Spring Security Configuration Generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # JWT security with roles
  python security_config_generator.py --type jwt --roles ADMIN,USER,MANAGER

  # OAuth2 resource server
  python security_config_generator.py --type oauth2 --issuer-uri https://auth.example.com

  # Custom package
  python security_config_generator.py --type jwt --roles ADMIN,USER --package com.myapp
"""
    )

    parser.add_argument("--type", required=True, choices=["jwt", "oauth2"],
                        help="Security type")
    parser.add_argument("--roles", default="ADMIN,USER",
                        help="Comma-separated roles (default: ADMIN,USER)")
    parser.add_argument("--issuer-uri",
                        help="OAuth2 issuer URI (required for oauth2 type)")
    parser.add_argument("--package", default="com.example",
                        help="Package name (default: com.example)")
    parser.add_argument("--output", "-o",
                        help="Output directory")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON")
    parser.add_argument("--version", action="version",
                        version=f"%(prog)s {__version__}")

    args = parser.parse_args()

    if args.type == "jwt":
        roles = [r.strip().upper() for r in args.roles.split(',')]
        files = generate_jwt_config(roles, args.package)
    else:
        if not args.issuer_uri:
            parser.error("--issuer-uri is required for oauth2 type")
        files = generate_oauth2_config(args.issuer_uri, args.package)

    result = {
        "type": args.type,
        "package": args.package,
        "files_generated": list(files.keys()),
    }

    if args.output:
        output_dir = Path(args.output)
        output_dir.mkdir(parents=True, exist_ok=True)
        for filename, content in files.items():
            (output_dir / filename).write_text(content)
        result["output_directory"] = str(output_dir)
        print(f"Security configuration generated in: {args.output}")
        for f in files.keys():
            print(f"  - {f}")
    elif args.json:
        result["files"] = files
        print(json.dumps(result, indent=2))
    else:
        for filename, content in files.items():
            print(f"\n{'='*60}")
            print(f"File: {filename}")
            print('='*60)
            print(content)


if __name__ == "__main__":
    main()
