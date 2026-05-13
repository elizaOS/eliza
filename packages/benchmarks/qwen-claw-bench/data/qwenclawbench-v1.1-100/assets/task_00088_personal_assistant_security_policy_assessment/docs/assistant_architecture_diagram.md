# Assistant System Architecture

**Document Version:** 2.1
**Last Updated:** 2024-01-20
**Classification:** Internal - Confidential
**Author:** Engineering Team

---

## 1. System Overview

The assistant system is deployed on a Raspberry Pi 4 (8GB) running Raspberry Pi OS.
It accepts commands from two trusted input channels (WhatsApp Direct and local
keyboard/mouse) and processes them through a multi-stage pipeline that includes
channel identification, trust evaluation, command parsing, permission checking,
execution, and audit logging.

---

## 2. High-Level Architecture

```
+------------------+     +------------------+     +------------------+
|  INPUT SOURCES   |     |  INPUT SOURCES   |     |  INPUT SOURCES   |
|                  |     |                  |     |  (Untrusted)     |
|  WhatsApp Direct |     |  RPi Local I/O   |     |  Email / PDF /   |
|  (Trusted)       |     |  (Trusted)       |     |  Web / Word      |
+--------+---------+     +--------+---------+     +--------+---------+
         |                        |                        |
         v                        v                        v
+--------+------------------------+------------------------+---------+
|                                                                     |
|                      CHANNEL IDENTIFIER                             |
|                                                                     |
|  Determines the source channel based on metadata headers and        |
|  transport layer information. Tags each incoming message with       |
|  a channel identifier string.                                       |
|                                                                     |
+-----------------------------------+---------------------------------+
                                    |
                                    v
+-----------------------------------+---------------------------------+
|                                                                     |
|                       TRUST EVALUATOR                               |
|                                                                     |
|  Looks up the channel identifier in the trust policy (YAML config)  |
|  and assigns a trust level: full, semi_trusted, or untrusted.       |
|  Routes untrusted sources directly to REJECTION handler.            |
|                                                                     |
+-----------------------------------+---------------------------------+
                                    |
                    +---------------+---------------+
                    |                               |
                    v                               v
+-------------------+----------+    +--------------+---------------+
|                              |    |                              |
|     COMMAND PARSER           |    |     REJECTION HANDLER        |
|                              |    |                              |
|  Extracts structured         |    |  Logs the rejection event    |
|  commands from natural       |    |  and sends notification to   |
|  language input. Identifies  |    |  the user via WhatsApp.      |
|  command type, parameters,   |    |  Increments violation        |
|  and target systems.         |    |  counter for escalation.     |
|                              |    |                              |
+-------------+----------------+    +------------------------------+
              |
              v
+-------------+------------------------------------------------+
|                                                              |
|                    PERMISSION CHECK                           |
|                                                              |
|  Validates that the parsed command is within the allowed      |
|  scope for the given trust level. Checks command category     |
|  against permission matrix. High-impact commands may require  |
|  additional confirmation even from trusted channels.          |
|                                                              |
+----------------------------+---------------------------------+
                             |
                             v
+----------------------------+---------------------------------+
|                                                              |
|                       EXECUTOR                               |
|                                                              |
|  Executes the approved command against the target system.     |
|  Handles smart home controls, messaging, scheduling,          |
|  system administration, and information retrieval.            |
|  Returns execution result to the user via the originating     |
|  channel.                                                    |
|                                                              |
+----------------------------+---------------------------------+
                             |
                             v
+----------------------------+---------------------------------+
|                                                              |
|                    AUDIT LOGGER                               |
|                                                              |
|  Records all events (commands, rejections, errors) to the     |
|  local log file. Includes timestamp, channel, action,         |
|  status, and detail fields.                                  |
|                                                              |
+--------------------------------------------------------------+
```

---

## 3. Component Details

### 3.1 Channel Identifier

**Purpose:** Determine the source channel for each incoming message.

**Implementation:**
- For WhatsApp messages: Reads the `X-WhatsApp-Source` header from the webhook
  payload and validates the sender phone number against the allowed list.
- For RPi local input: Detects input from whitelisted USB HID devices via
  the device VID/PID matching system.
- For other sources: Identifies based on transport metadata (email headers,
  HTTP referrer for web content, file MIME type for documents).

**Known Limitations:**
> **SECURITY NOTE:** The Channel Identifier relies solely on metadata headers
> and transport-layer information to determine the source channel. This creates
> a potential spoofing risk if an attacker can manipulate these headers. For
> WhatsApp, the webhook payload headers are provided by the WhatsApp Business
> API and are generally trustworthy, but the system does not independently
> verify the sender's identity beyond phone number matching.
>
> **CRITICAL ISSUE:** When a trusted channel is used to request processing of
> content from an untrusted source (e.g., "summarize this webpage"), the
> Channel Identifier tags the entire interaction with the trusted channel's
> identifier. This means that instructions embedded in the untrusted content
> may inherit the trust level of the requesting channel. This is a known
> architectural vulnerability (see INC-2024-005).

### 3.2 Trust Evaluator

**Purpose:** Assign trust levels based on the channel identifier.

**Implementation:**
- Loads the trust policy from `policies/current_trust_policy_v2.yaml`
- Performs a lookup of the channel identifier against the policy's
  `trusted_channels` and `untrusted_sources` sections
- Assigns trust level: `full`, `semi_trusted`, or `untrusted`
- Routes untrusted sources to the Rejection Handler

**Known Limitations:**
> **SECURITY NOTE:** The Trust Evaluator performs a static policy lookup with
> no behavioral analysis or anomaly detection. It does not consider:
> - Time-of-day patterns (commands at unusual hours are not flagged)
> - Command frequency anomalies (burst of commands is not detected)
> - Device fingerprint changes (new device is not flagged)
> - Command content anomalies (unusual command types are not flagged)
> - Session context (no tracking of conversation flow or command sequences)
>
> This means that a compromised trusted channel (e.g., hijacked WhatsApp
> session) will have full trust with no additional scrutiny. The system
> cannot distinguish between the legitimate user and an attacker using
> the same channel.

### 3.3 Command Parser

**Purpose:** Extract structured commands from natural language input.

**Implementation:**
- Uses NLP-based intent classification to identify command type
- Extracts parameters and target systems from the message
- Supports both explicit commands ("turn off living room lights") and
  implicit commands ("it's too bright in here")
- Returns a structured command object with: `command_type`, `parameters`,
  `target_system`, `confidence_score`

**Security Consideration:**
- Commands with confidence score below 0.7 require user confirmation
- Ambiguous commands are clarified before execution
- The parser does not distinguish between user-originated instructions
  and instructions embedded in processed content (see Channel Identifier
  limitations above)

### 3.4 Permission Check

**Purpose:** Validate command authorization against the permission matrix.

**Implementation:**
- Cross-references command type with the trust level's allowed operations
- High-impact command categories (network, security, export, credential)
  should require additional confirmation (NOTE: this is currently only
  partially implemented — see `require_reauth_for_sensitive_commands=false`
  in the RPi config)
- Rate limiting: maximum 30 commands per minute per channel

### 3.5 Executor

**Purpose:** Execute approved commands against target systems.

**Supported Target Systems:**
- Smart home devices (lights, thermostat, locks, fans, cameras)
- Messaging (WhatsApp, email composition)
- Scheduling (calendar, reminders, alarms)
- System administration (updates, backups, diagnostics)
- Information retrieval (weather, news, stocks)

### 3.6 Audit Logger

**Purpose:** Record all system events for security auditing.

**Log Format:**
```
[YYYY-MM-DD HH:MM:SS] [CHANNEL] [ACTION] [STATUS] [DETAIL]
```

**Log Storage:**
- Location: `/var/log/rpi_assistant/`
- Retention: 365 days
- Rotation: 50 MB per file

**Known Limitations:**
> **SECURITY NOTE:** The audit logger stores logs locally on the RPi
> filesystem with no tamper protection. An attacker with local access
> could modify or delete log entries to cover their tracks. There is
> no remote syslog forwarding configured, no integrity checksums on
> log files, and no append-only file system protections. See THR-012
> in the threat registry.

---

## 4. Data Flow Diagram

```
                    +------------------------------------------+
                    |           EXTERNAL WORLD                  |
                    +------------------------------------------+
                         |              |              |
                    WhatsApp API    USB HID      Email/Web/PDF
                         |              |              |
                    +----v--------------v--------------v-------+
                    |              CHANNEL IDENTIFIER           |
                    |  (metadata-based source determination)    |
                    +----+-------------------------------------+
                         |
                    +----v-------------------------------------+
                    |              TRUST EVALUATOR              |
                    |  (static policy lookup, no anomaly det.) |
                    +----+------------------+------------------+
                         |                  |
                    TRUSTED            UNTRUSTED
                         |                  |
                    +----v------+     +-----v-----------------+
                    | CMD PARSER|     | REJECTION HANDLER     |
                    +----+------+     | (log + notify + count)|
                         |            +-----+-----------------+
                    +----v------+           |
                    | PERM CHECK|     +-----v-----------------+
                    +----+------+     | ESCALATION ENGINE     |
                         |            | (lockdown if threshold)|
                    +----v------+     +-----------------------+
                    | EXECUTOR  |
                    +----+------+
                         |
                    +----v------+
                    | AUDIT LOG |
                    +-----------+
```

---

## 5. Deployment Configuration

| Component | Technology | Version |
|-----------|-----------|---------|
| Hardware | Raspberry Pi 4 Model B | 8GB RAM |
| OS | Raspberry Pi OS (Debian 12) | Bookworm |
| Runtime | Python 3.11 | 3.11.6 |
| WhatsApp Integration | WhatsApp Business API | v18.0 |
| Smart Home | Home Assistant API | 2024.1 |
| Database | SQLite | 3.42 |
| Web Server | Flask | 3.0.0 |

---

## 6. Security Architecture Notes

### 6.1 Current Security Posture

The system relies on a **perimeter-based trust model** where the channel of
communication determines the trust level. Once a message passes the Channel
Identifier and Trust Evaluator, it is treated as fully authorized.

### 6.2 Known Architectural Gaps

1. **No defense-in-depth for trusted channels** — A compromised WhatsApp account
   has unrestricted access with no secondary verification.

2. **Content origin vs. request origin confusion** — The system cannot distinguish
   between instructions from the user and instructions embedded in content the
   user asked to process.

3. **No behavioral baseline** — The system has no model of "normal" usage patterns
   and cannot detect anomalies.

4. **Local-only audit trail** — Logs can be tampered with by anyone with local access.

5. **No MFA for any channel** — Neither WhatsApp nor local access requires
   multi-factor authentication.

### 6.3 Recommended Improvements

- Implement device fingerprint tracking and alerting for WhatsApp
- Add time-of-day anomaly detection
- Enable local PIN requirement for RPi access
- Deploy remote syslog forwarding with integrity verification
- Implement content-origin tagging separate from channel identification
- Add MFA requirement for high-impact commands

---

*Document maintained by the Engineering Team. Last architecture review: 2024-01-20.*
