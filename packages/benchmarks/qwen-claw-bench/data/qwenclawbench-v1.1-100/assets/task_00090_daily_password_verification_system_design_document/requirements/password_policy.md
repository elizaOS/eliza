# Dynamic Daily Password Policy

**Document ID:** SEC-POL-2024-017  
**Version:** 3.2  
**Last Updated:** 2024-11-15  
**Classification:** Internal — Restricted

---

## 1. Overview

This document defines the construction rule for the **Dynamic Daily Password** used to authorize high-risk operations within the platform. The password changes every calendar day and is deterministically derived from the current date. All authorized personnel and automated systems must use this rule when generating or verifying daily passwords.

The daily password serves as a secondary verification factor for operations classified as **critical** or **high** risk (see `requirements/high_risk_operations.yaml`).

---

## 2. Password Construction Rule

The daily password is a **5-character numeric string** constructed as follows:

```
password = MMDD + weekday_digit
```

Where:

- **MMDD** — The two-digit month and two-digit day of the current date, **zero-padded**.
  - January 1 → `0101`
  - March 15 → `0315`
  - December 25 → `1225`
  - September 9 → `0909`

- **weekday_digit** — A single digit representing the day of the week, using the **custom mapping** defined in Section 4 below.

The final password is the concatenation of MMDD (4 digits) and the weekday_digit (1 digit), yielding a 5-digit string.

### Examples

| Date           | MMDD   | Day of Week | Weekday Digit | Password |
|----------------|--------|-------------|---------------|----------|
| 2025-01-01     | 0101   | Wednesday   | 3             | `01013`  |
| 2025-03-15     | 0315   | Saturday    | 6             | `03156`  |
| 2025-12-25     | 1225   | Thursday    | 4             | `12254`  |

> **Important:** The MMDD portion must always be zero-padded to exactly 4 digits. Single-digit months and days must include a leading zero. Failure to zero-pad will result in incorrect passwords.

---

## 3. Timezone Policy

All date computations for the daily password **must** use the **Los Angeles timezone** (`America/Los_Angeles`), regardless of:

- The user's physical location
- The user's configured display timezone preference
- The server's system timezone
- Any other regional or locale setting

**Canonical Timezone:** `America/Los_Angeles` (Pacific Time)

This means:
- During Pacific Standard Time (PST, UTC−8): the password rolls over at midnight PST.
- During Pacific Daylight Time (PDT, UTC−7): the password rolls over at midnight PDT.

> **Note:** Users in other timezones (e.g., UTC, Eastern, or international) must compute the password based on the current date **in Los Angeles**, not their local date. Near the date boundary, the Los Angeles date may differ from the user's local date.

---

## 4. Weekday Mapping

The following **custom weekday mapping** is used. This mapping differs from ISO 8601 (which assigns Monday=1 through Sunday=7).

| Day of Week | Weekday Digit |
|-------------|---------------|
| Sunday      | 7             |
| Monday      | 1             |
| Tuesday     | 2             |
| Wednesday   | 3             |
| Thursday    | 4             |
| Friday      | 5             |
| Saturday    | 6             |

> **Warning:** Do **not** use ISO 8601 weekday numbering (Monday=1, Sunday=7). Our custom mapping assigns **Sunday=7** and **Monday=1**. While Sunday=7 coincidentally matches ISO 8601, Saturday=6 also matches, but the conceptual basis is different: our system starts the week on Sunday, not Monday.

> **Warning:** Do **not** use zero-indexed weekday systems (Sunday=0). Some programming languages (e.g., JavaScript's `getDay()`, C's `tm_wday`) return Sunday=0. Our system uses Sunday=**7**, not Sunday=0.

---

## 5. Usage Context

The daily password is required for all operations classified as **critical** or **high** risk. The complete list of such operations is maintained in `requirements/high_risk_operations.yaml`.

### Verification Flow

1. A user or automated process initiates a high-risk operation.
2. The system prompts for the daily password.
3. The submitted password is verified against the expected password for the current date in `America/Los_Angeles`.
4. If verification succeeds, the operation proceeds.
5. If verification fails, the attempt is logged and the user may retry up to the configured maximum attempts (see `config/auth_config.yaml`).

### Security Considerations

- The daily password should **never** be logged in plaintext.
- The daily password should **never** be echoed back to the user in confirmation messages.
- All verification should occur server-side; the expected password should not be transmitted to the client.

---

## 6. Revision History

| Version | Date       | Author         | Changes                              |
|---------|------------|----------------|--------------------------------------|
| 1.0     | 2023-06-01 | J. Martinez    | Initial draft                        |
| 2.0     | 2024-01-15 | J. Martinez    | Added timezone policy                |
| 3.0     | 2024-07-20 | S. Chen        | Clarified weekday mapping warnings   |
| 3.1     | 2024-09-10 | S. Chen        | Added zero-padding requirement       |
| 3.2     | 2024-11-15 | R. Okonkwo     | Added security considerations        |
