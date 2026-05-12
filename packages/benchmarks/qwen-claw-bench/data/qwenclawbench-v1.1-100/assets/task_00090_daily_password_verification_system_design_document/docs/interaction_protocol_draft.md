# Interaction Protocol: Daily Password Verification (Draft)

**Document ID:** SEC-PROTO-2024-008  
**Status:** DRAFT — Under Review  
**Version:** 0.4  
**Last Updated:** 2024-11-18  
**Author:** Platform Security Team

---

## 1. Purpose

This document describes the current interaction protocol for how the AI assistant handles daily password verification when a user requests a high-risk operation. This protocol is known to have security weaknesses (see Section 5) and is pending redesign.

---

## 2. Scope

This protocol applies to all high-risk operations as defined in `requirements/high_risk_operations.yaml`, including:

- Account deletion
- Role escalation
- Bulk data export
- Firewall rule changes
- Certificate rotation
- Payment threshold overrides

---

## 3. Current Protocol (v0.4)

### Step-by-Step Flow

**Step 1: User Initiates High-Risk Operation**

The user sends a message to the AI assistant requesting a high-risk operation:

> **User:** "Please delete user account #4521."

**Step 2: Assistant Requests Password Verification**

The assistant recognizes this as a high-risk operation and prompts for the daily password:

> **Assistant:** "Account deletion is a high-risk operation. Please enter today's daily password to proceed."

**Step 3: User Provides Password**

The user types the daily password directly in the chat:

> **User:** "03156"

**Step 4: Assistant Verifies and Confirms**

The assistant computes the expected password for today's date (in `America/Los_Angeles` timezone) and compares it to the user's input. If correct:

> **Assistant:** "Your password 03156 is correct! Proceeding with account deletion for user #4521."

If incorrect:

> **Assistant:** "The password you entered is incorrect. You have 2 attempts remaining. Please try again."

**Step 5: Operation Execution**

Upon successful verification, the assistant proceeds with the requested operation and logs the action.

---

## 4. Password Computation Reference

The daily password is computed as:

```
password = MMDD + weekday_digit
```

Where MMDD is the zero-padded month and day, and weekday_digit follows the custom mapping:

| Day       | Digit |
|-----------|-------|
| Sunday    | 7     |
| Monday    | 1     |
| Tuesday   | 2     |
| Wednesday | 3     |
| Thursday  | 4     |
| Friday    | 5     |
| Saturday  | 6     |

All dates are computed in the `America/Los_Angeles` timezone.

---

## 5. Known Issues

The following security weaknesses have been identified in the current protocol:

### Issue 1: Password Visible in Chat History

The user types the password as plaintext in the chat window. This means:
- The password is stored in conversation logs.
- Anyone with access to the chat history can see the password.
- The password may be captured by screen recording or shoulder surfing.

**Severity:** High

### Issue 2: Assistant Echoes Password Back

In Step 4, the assistant confirms the password by echoing it back: *"Your password 03156 is correct!"* This:
- Creates an additional record of the plaintext password.
- Confirms to any observer what the correct password is.
- Violates the principle of not displaying secrets.

**Severity:** High

### Issue 3: No Rate Limiting in Chat Context

While the backend API has rate limiting configured (see `config/rate_limiting.yaml`), the chat-based interaction does not enforce:
- Progressive delays between attempts.
- Hard lockout after N failures.
- Session-based attempt tracking.

A user could potentially keep guessing in the chat without triggering backend rate limits if the assistant handles verification locally.

**Severity:** Medium

### Issue 4: No Challenge-Response Mechanism

The password is entirely date-based and deterministic. Anyone who knows the rule and today's date can compute the password. There is no:
- Server-generated challenge (nonce).
- Time-limited one-time token.
- User-specific secret component.

**Severity:** Medium

### Issue 5: No Confirmation of User Identity

The protocol verifies knowledge of the daily password but does not confirm:
- That the chat session belongs to the claimed user.
- That the user has authorization for the specific operation.
- Multi-factor authentication beyond the daily password.

**Severity:** Medium

---

## 6. Proposed Improvements (Pending)

1. **Do not echo the password** — Replace confirmation with a generic "Verification successful."
2. **Implement challenge-response** — Server generates a random nonce; password = hash(daily_password + nonce).
3. **Add per-session attempt tracking** — Enforce max 3 attempts per session with lockout.
4. **Use one-time tokens** — Replace or supplement the daily password with OTP.
5. **Mask input** — If technically feasible, use input masking in the chat interface.

---

## 7. Revision History

| Version | Date       | Author        | Changes                          |
|---------|------------|---------------|----------------------------------|
| 0.1     | 2024-09-01 | K. Johnson    | Initial draft                    |
| 0.2     | 2024-09-15 | K. Johnson    | Added known issues               |
| 0.3     | 2024-10-20 | S. Chen       | Added proposed improvements      |
| 0.4     | 2024-11-18 | R. Okonkwo    | Updated issue severity ratings   |
