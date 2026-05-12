# Competitor MFA Solutions Analysis

**Document ID:** SEC-RESEARCH-2024-012  
**Date:** 2024-10-30  
**Author:** Platform Security Research Team  
**Classification:** Internal

---

## 1. Overview

This document provides a comparative analysis of multi-factor authentication (MFA) solutions used by competitors and industry leaders. The goal is to evaluate potential alternatives or supplements to our current authentication mechanisms.

> **Note:** This analysis covers general-purpose MFA approaches. It does not describe or evaluate our internal daily password scheme.

---

## 2. MFA Methods Compared

### 2.1 TOTP (Time-Based One-Time Password)

**Standard:** RFC 6238  
**Examples:** Google Authenticator, Authy, Microsoft Authenticator

**How it works:**  
A shared secret is established during enrollment. The authenticator app generates a 6-digit code every **30 seconds** based on `HMAC-SHA1(secret, floor(current_unix_time / 30))`. The server accepts codes within a ±1 window (90-second validity).

| Aspect              | Details                                    |
|---------------------|--------------------------------------------|
| Code Length          | 6 digits                                   |
| Validity Window      | 30 seconds (±1 step = 90s effective)       |
| Requires Internet    | No (after initial setup)                   |
| Hardware Required    | Smartphone or hardware token               |
| Setup Complexity     | Low (QR code scan)                         |
| Phishing Resistance  | Low (codes can be relayed in real-time)    |

**Pros:**
- Widely adopted and well-understood.
- Works offline after initial enrollment.
- Low cost (free authenticator apps available).
- Standardized — interoperable across providers.

**Cons:**
- Vulnerable to real-time phishing attacks.
- Shared secret must be stored securely on the server.
- Recovery is complex if the user loses their device.
- 30-second window could be confused with longer-duration schemes.

**Estimated Cost:** $0–$3/user/year (software-based); $15–$50/user for hardware tokens.

---

### 2.2 FIDO2 / WebAuthn

**Standard:** W3C WebAuthn + FIDO2 CTAP2  
**Examples:** YubiKey, Windows Hello, Apple Touch ID/Face ID, Android biometrics

**How it works:**  
Public-key cryptography. During registration, the authenticator generates a key pair; the public key is stored on the server. During authentication, the server sends a challenge, the authenticator signs it with the private key, and the server verifies the signature.

| Aspect              | Details                                    |
|---------------------|--------------------------------------------|
| Code Length          | N/A (cryptographic signature)              |
| Validity Window      | Single-use per challenge                   |
| Requires Internet    | Yes (for challenge delivery)               |
| Hardware Required    | Security key, platform authenticator, or biometric sensor |
| Setup Complexity     | Medium                                     |
| Phishing Resistance  | High (origin-bound credentials)            |

**Pros:**
- Strongest phishing resistance of any MFA method.
- No shared secrets — private key never leaves the authenticator.
- Supports biometric verification (fingerprint, face).
- Growing browser and OS support.

**Cons:**
- Requires compatible hardware (security key or biometric sensor).
- Higher upfront cost for hardware security keys.
- Limited support in legacy systems and older browsers.
- Account recovery requires backup keys or alternative methods.

**Estimated Cost:** $25–$70/user for hardware keys; $0 for platform authenticators (if devices support it).

---

### 2.3 SMS OTP

**Standard:** No formal standard (carrier-dependent)  
**Examples:** Most banking apps, legacy enterprise systems

**How it works:**  
The server generates a random 4–6 digit code and sends it via SMS to the user's registered phone number. The user enters the code within a time window (typically 5–10 minutes).

| Aspect              | Details                                    |
|---------------------|--------------------------------------------|
| Code Length          | 4–6 digits                                 |
| Validity Window      | 5–10 minutes                               |
| Requires Internet    | No (uses cellular network)                 |
| Hardware Required    | Any mobile phone with SMS capability       |
| Setup Complexity     | Very low                                   |
| Phishing Resistance  | Very low                                   |

**Pros:**
- Universally accessible — works on any phone with SMS.
- No app installation required.
- Users are familiar with the flow.

**Cons:**
- Vulnerable to SIM swapping attacks.
- SMS can be intercepted (SS7 vulnerabilities).
- Delivery delays and failures in some regions.
- NIST SP 800-63B deprecates SMS as an authenticator.
- Carrier costs for high-volume SMS delivery.

**Estimated Cost:** $0.01–$0.05/SMS; $1–$5/user/year at typical usage.

---

### 2.4 Push Notification

**Standard:** Proprietary (vendor-specific)  
**Examples:** Duo Push, Microsoft Authenticator push, Okta Verify

**How it works:**  
When authentication is required, the server sends a push notification to the user's enrolled device. The user reviews the request details (service, location, time) and taps "Approve" or "Deny."

| Aspect              | Details                                    |
|---------------------|--------------------------------------------|
| Code Length          | N/A (approve/deny)                         |
| Validity Window      | 30–60 seconds                              |
| Requires Internet    | Yes (push notification delivery)           |
| Hardware Required    | Smartphone with vendor app                 |
| Setup Complexity     | Low–Medium                                 |
| Phishing Resistance  | Medium (number matching improves this)     |

**Pros:**
- Excellent user experience — single tap to approve.
- Can display context (location, device, service).
- Number matching feature reduces MFA fatigue attacks.
- No code to type — reduces errors.

**Cons:**
- Requires internet connectivity on the mobile device.
- Vulnerable to MFA fatigue/prompt bombing attacks (without number matching).
- Vendor lock-in (proprietary protocols).
- Requires dedicated app installation.

**Estimated Cost:** $3–$9/user/month (SaaS licensing); varies by vendor.

---

## 3. Comparison Matrix

| Feature                  | TOTP    | FIDO2/WebAuthn | SMS OTP  | Push Notification |
|--------------------------|---------|----------------|----------|-------------------|
| Phishing Resistance      | Low     | **High**       | Very Low | Medium            |
| Offline Capability       | **Yes** | No             | **Yes**  | No                |
| User Experience          | Medium  | High           | Low      | **High**          |
| Setup Complexity         | Low     | Medium         | **Low**  | Low–Medium        |
| Hardware Cost            | Low     | Medium–High    | **None** | Low               |
| Standards-Based          | **Yes** | **Yes**        | No       | No                |
| Recovery Complexity      | Medium  | High           | **Low**  | Medium            |
| Regulatory Compliance    | Good    | **Excellent**  | Poor     | Good              |

---

## 4. Cost Comparison (1,000 Users, Annual)

| Method             | Setup Cost  | Annual Cost  | Total Year 1 |
|--------------------|-------------|--------------|---------------|
| TOTP (software)    | $0          | $0           | $0            |
| TOTP (hardware)    | $25,000     | $2,000       | $27,000       |
| FIDO2 (YubiKey)    | $50,000     | $5,000       | $55,000       |
| FIDO2 (platform)   | $0          | $0           | $0            |
| SMS OTP            | $0          | $30,000      | $30,000       |
| Push (Duo)         | $5,000      | $36,000      | $41,000       |
| Push (Okta)        | $8,000      | $48,000      | $56,000       |

---

## 5. Recommendations

1. **Short-term:** Adopt TOTP as a baseline MFA method. It is free, standards-based, and widely supported.
2. **Medium-term:** Pilot FIDO2/WebAuthn with platform authenticators for high-privilege users.
3. **Long-term:** Deprecate SMS OTP entirely. Migrate to FIDO2 as the primary method with push notification as a fallback.

---

## 6. References

- NIST SP 800-63B: Digital Identity Guidelines — Authentication and Lifecycle Management
- FIDO Alliance: https://fidoalliance.org/
- RFC 6238: TOTP — Time-Based One-Time Password Algorithm
- RFC 4226: HOTP — HMAC-Based One-Time Password Algorithm
- W3C WebAuthn: https://www.w3.org/TR/webauthn-2/
