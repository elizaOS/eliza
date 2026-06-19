# Threat Model — Compensation Service

**Document ID:** TM-COMP-2024-001  
**Version:** 1.2  
**Last Updated:** 2024-02-28  
**Author:** Security Architecture Team  
**Status:** Approved  

---

## 1. System Overview

The Compensation Service is a Spring Boot microservice responsible for managing compensation records in the order fulfillment pipeline. It provides APIs for querying, creating, and exporting compensation data, as well as rendering user-facing dashboard pages.

### Architecture Context

- **Runtime:** Spring Boot 2.x on Tomcat (embedded)
- **Database:** MySQL 8.0 (internal network 10.0.1.x)
- **Access:** Exposed via API gateway to internal and external consumers
- **Authentication:** Bearer token (JWT) — defined in API spec but implementation status unclear
- **File System:** Read/write access to `/opt/compensation-service/exports/` for report generation

---

## 2. Assets

| Asset ID | Asset                        | Classification | Description                                              |
|----------|------------------------------|----------------|----------------------------------------------------------|
| A1       | Compensation Records         | Confidential   | Financial records including order IDs, amounts, statuses |
| A2       | User Credentials             | Secret         | Usernames and passwords processed by the service         |
| A3       | Database Credentials         | Secret         | MySQL connection credentials used by the application     |
| A4       | Export Reports               | Confidential   | Generated CSV/PDF reports containing financial data      |
| A5       | Application Logs             | Internal       | Runtime logs that may inadvertently contain sensitive data|

---

## 3. Threat Actors

| Actor ID | Actor                    | Motivation                     | Capability |
|----------|--------------------------|--------------------------------|------------|
| TA1      | External Attacker        | Financial gain, data theft     | High       |
| TA2      | Malicious Insider        | Data exfiltration, sabotage    | Medium     |
| TA3      | Automated Scanner/Bot    | Opportunistic exploitation     | Low-Medium |
| TA4      | Compromised Supply Chain | Backdoor via vulnerable deps   | High       |

---

## 4. STRIDE Analysis

### 4.1 Spoofing

| Threat                                    | Risk   | Mitigation Status |
|-------------------------------------------|--------|--------------------|
| Forged JWT tokens to access API endpoints | High   | Partially mitigated — JWT validation exists at gateway but not enforced in service code |
| Credential stuffing against user accounts | Medium | Rate limiting at gateway layer |

### 4.2 Tampering

| Threat                                         | Risk   | Mitigation Status |
|------------------------------------------------|--------|--------------------|
| SQL injection to modify compensation records   | Critical | **REQUIRES REVIEW** — previous audit claimed fix, needs verification |
| Modification of export files on disk           | Medium | File permissions set to 640 |

### 4.3 Repudiation

| Threat                                    | Risk   | Mitigation Status |
|-------------------------------------------|--------|--------------------|
| Unauthorized compensation creation without audit trail | Medium | Audit logging exists but completeness not verified |

### 4.4 Information Disclosure

| Threat                                         | Risk     | Mitigation Status |
|------------------------------------------------|----------|--------------------|
| Sensitive data leakage in application logs     | High     | **UNMITIGATED** — password fields may be logged |
| Hardcoded credentials in source code           | Critical | **UNMITIGATED** — known issue, vault migration pending |
| Path traversal to read arbitrary files         | Critical | **REQUIRES REVIEW** — export functionality uses user-supplied filenames |

### 4.5 Denial of Service

| Threat                                    | Risk   | Mitigation Status |
|-------------------------------------------|--------|--------------------|
| Resource exhaustion via PageHelper memory leak | Medium | **UNMITIGATED** — ThreadLocal leak reported |
| Large file export causing OOM             | Low    | File size limits not implemented |

### 4.6 Elevation of Privilege

| Threat                                    | Risk   | Mitigation Status |
|-------------------------------------------|--------|--------------------|
| XSS to steal admin session tokens         | High   | **REQUIRES REVIEW** — user page rendering may be vulnerable |
| SQL injection to escalate DB privileges   | Critical | **REQUIRES REVIEW** |

---

## 5. High-Risk Areas Requiring Immediate Attention

### 5.1 Export Functionality (`exportReport`)

The export endpoint accepts a user-supplied `filename` parameter and constructs a file path by concatenating it with a base directory. **This is a classic path traversal attack vector.** An attacker could supply `../../../etc/passwd` to read arbitrary files from the server.

**Required Controls:**
- Whitelist of allowed filenames or filename patterns
- Canonical path validation (resolve path and verify it remains under base directory)
- Input sanitization to reject `../`, `..\\`, null bytes, and URL-encoded variants

### 5.2 User Page Rendering (`renderUserPage`)

The user page endpoint takes a `name` parameter and embeds it directly into HTML output. **This is a reflected XSS attack vector.** An attacker could inject `<script>` tags to execute arbitrary JavaScript in the victim's browser.

**Required Controls:**
- HTML output encoding (use OWASP Java Encoder or Spring's `HtmlUtils.htmlEscape`)
- Content Security Policy headers
- Input validation to reject HTML/JavaScript characters

### 5.3 Compensation Query (`queryCompensation`)

The query endpoint constructs SQL queries using string concatenation with user input. **This is a SQL injection attack vector.** An attacker could manipulate the `orderId` parameter to extract, modify, or delete data.

**Required Controls:**
- Use `PreparedStatement` with parameterized queries
- Input validation on `orderId` format (should match pattern `ORD-YYYYMMDD-NNN`)
- Least-privilege database account (read-only for query operations)

---

## 6. Recommendations

1. **Immediate (P0):** Verify SQL injection fix claimed in previous audit — re-test with manual penetration testing
2. **Immediate (P0):** Implement path traversal protection in export functionality
3. **High (P1):** Add HTML output encoding to user page rendering
4. **High (P1):** Remove hardcoded credentials and migrate to secrets management
5. **High (P1):** Audit all log statements for sensitive data leakage
6. **Medium (P2):** Upgrade all dependencies with known CVEs
7. **Medium (P2):** Add security regression tests to the test suite
8. **Low (P3):** Fix code quality issues (unused imports, empty catch blocks, redundant code)

---

*This threat model should be reviewed and updated quarterly or when significant changes are made to the service.*
