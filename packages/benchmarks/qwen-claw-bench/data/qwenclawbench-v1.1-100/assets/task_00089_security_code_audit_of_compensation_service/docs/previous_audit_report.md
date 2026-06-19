# Security Audit Report — Compensation Service

**Report ID:** SAR-2024-0115  
**Date:** 2024-01-15  
**Auditor:** Li Wei, Application Security Team  
**Scope:** `com.wish.biz.rs.compensationbus` — compensation-service v2.3.1  
**Classification:** Internal — Confidential  

---

## Executive Summary

A security code review was performed on the compensation service module as part of the Q1 2024 security audit cycle. The review identified 5 findings, of which 2 have been resolved in the v2.3.1 release. The remaining 3 findings are tracked for remediation in the next sprint.

Overall risk assessment: **Medium** (reduced from High after v2.3.1 fixes)

---

## Findings

### Finding #1: SQL Injection in queryCompensation()

| Attribute     | Value                                      |
|---------------|--------------------------------------------|
| **ID**        | VULN-2024-001                              |
| **Severity**  | Critical                                   |
| **Status**    | ✅ RESOLVED                                |
| **Location**  | `CompensationServiceImpl.java`, line ~45   |
| **CWE**       | CWE-89: SQL Injection                      |

**Description:** The `queryCompensation` method previously used string concatenation to build a SQL query with the user-supplied `orderId` parameter, allowing potential SQL injection attacks.

**Resolution:** Fixed in v2.3.1 by replacing `Statement` with `PreparedStatement` and using parameterized query binding. The following diff was applied in commit `7a2f3d1` (2024-01-12):

```diff
-  String sql = "SELECT * FROM compensation WHERE order_id = '" + orderId + "'";
-  stmt = conn.createStatement();
-  rs = stmt.executeQuery(sql);
+  String sql = "SELECT * FROM compensation WHERE order_id = ?";
+  PreparedStatement pstmt = conn.prepareStatement(sql);
+  pstmt.setString(1, orderId);
+  rs = pstmt.executeQuery();
```

**Verification:** Unit test `QueryCompensationParameterizedTest.testSqlInjectionPrevented()` was added and passes. Re-scan with Fortify SCA on 2024-01-14 confirmed no remaining SQL injection findings in the `queryCompensation` method. Peer-reviewed by two senior developers.

---

### Finding #2: Reflected XSS in renderUserPage()

| Attribute     | Value                                      |
|---------------|--------------------------------------------|
| **ID**        | VULN-2024-002                              |
| **Severity**  | Low                                        |
| **Status**    | 🔶 ACCEPTED RISK                           |
| **Location**  | `CompensationServiceImpl.java`, line ~72   |
| **CWE**       | CWE-79: Cross-site Scripting               |

**Description:** The `renderUserPage` method directly embeds the user-supplied `name` parameter into an HTML response without output encoding.

**Risk Assessment:** This endpoint is only accessible from the internal admin console behind VPN and corporate SSO. The attack surface is limited to authenticated internal administrators. Given the restricted access and low likelihood of exploitation, this has been accepted as a low-severity risk.

**Updated Assessment (2024-01-18):** After further review with the architecture team, the `/api/compensation/user-page` endpoint was confirmed to be served exclusively through the internal admin portal's embedded iframe. The API specification description stating "user-facing endpoint accessible to all authenticated users" is a documentation inaccuracy that has been reported to the API documentation team (JIRA DOC-1892). The actual routing rules at the API gateway restrict this path to the `ROLE_ADMIN` group. Severity remains Low.

**Recommendation:** Consider adding HTML encoding in a future release as a defense-in-depth measure.

---

### Finding #3: Hardcoded Database Password

| Attribute     | Value                                      |
|---------------|--------------------------------------------|
| **ID**        | VULN-2024-003                              |
| **Severity**  | High                                       |
| **Status**    | 🔴 OPEN                                    |
| **Location**  | `CompensationServiceImpl.java`, line ~28   |
| **CWE**       | CWE-798: Hardcoded Credentials             |

**Description:** The database password `Admin@123` is hardcoded as a class field. The same password appears in `application.yml`. This violates security policy SEC-001.

**Recommendation:** Migrate to HashiCorp Vault or Spring Cloud Config Server for credential management. A JIRA ticket (SEC-4521) has been created and assigned to the platform team.

---

### Finding #4: Generic Exception Handling with Empty Catch Block

| Attribute     | Value                                      |
|---------------|--------------------------------------------|
| **ID**        | VULN-2024-004                              |
| **Severity**  | Medium                                     |
| **Status**    | 🔴 OPEN                                    |
| **Location**  | `CompensationServiceImpl.java`, line ~110  |
| **CWE**       | CWE-396: Catch Generic Exception           |

**Description:** The `createCompensation` method catches `Exception` broadly and has an empty catch block with only a TODO comment. This can silently swallow errors including security-relevant exceptions such as `AccessDeniedException` or `SQLIntegrityConstraintViolationException`.

**Recommendation:** Replace with specific exception types and add proper error logging and handling.

---

### Finding #5: Unused Imports

| Attribute     | Value                                      |
|---------------|--------------------------------------------|
| **ID**        | CODE-2024-001                              |
| **Severity**  | Low (Code Quality)                         |
| **Status**    | ✅ RESOLVED                                |
| **Location**  | `CompensationServiceImpl.java`, line ~12   |

**Description:** Unused import `java.io.File` was present in the source file.

**Resolution:** Removed in v2.3.1 code cleanup (commit `e91bc4a`, 2024-01-12). Verified by `mvn checkstyle:check` — zero unused import violations in the final v2.3.1 build artifact. The development team confirmed no code references `java.io.File` in the current release.

---

## Summary Table

| ID             | Finding                  | Severity | Status        |
|----------------|--------------------------|----------|---------------|
| VULN-2024-001  | SQL Injection            | Critical | ✅ RESOLVED   |
| VULN-2024-002  | Reflected XSS            | Low      | 🔶 ACCEPTED   |
| VULN-2024-003  | Hardcoded Password       | High     | 🔴 OPEN       |
| VULN-2024-004  | Generic Exception        | Medium   | 🔴 OPEN       |
| CODE-2024-001  | Unused Imports           | Low      | ✅ RESOLVED   |

---

## Next Steps

1. Platform team to complete Vault integration for credential management (ETA: 2024-02-28)
2. Development team to refactor exception handling in next sprint
3. Schedule follow-up audit for Q2 2024

---

*Report generated by Wish BizTech Application Security Team. For questions, contact appsec@wish.internal.*
