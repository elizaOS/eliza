# Social Engineering Attack Scenarios

**Document Version:** 1.2  
**Last Updated:** 2024-02-15  
**Classification:** Confidential  
**Author:** Security Operations Team  

---

## Overview

This document describes detailed social engineering attack scenarios that specifically
target the trust boundary between trusted and untrusted input channels in the personal
assistant system. Each scenario illustrates how an attacker could exploit the human
element to bypass technical controls, effectively "laundering" untrusted instructions
through trusted channels.

These scenarios are based on real-world attack patterns, threat intelligence, and
findings from the 2024 penetration test engagement.

---

## Scenario 1: Command Laundering via PDF + Phone Call Chain Attack

### Description

A multi-stage attack where the attacker first delivers a malicious payload via an
untrusted channel (PDF document) and then uses social engineering to convince the
legitimate user to relay the embedded commands through the trusted WhatsApp channel.

### Attack Steps

1. **Reconnaissance:** Attacker identifies that the target uses a personal assistant
   system with WhatsApp as a trusted input channel and that email/PDF sources are
   untrusted.

2. **Payload Delivery:** Attacker sends a professionally formatted PDF document to
   the target via email. The document appears to be a legitimate system configuration
   guide or troubleshooting document from the target's ISP, smart home vendor, or
   IT support provider.

3. **Embedded Instructions:** The PDF contains a section titled "Quick Setup Commands"
   or "Troubleshooting Steps" with specific commands that, if executed by the
   assistant, would:
   - Modify network DNS settings to attacker-controlled servers
   - Disable firewall rules for specific ports
   - Add a new trusted phone number to the allowed senders list
   - Export system configuration or credentials

4. **Social Engineering Call:** Shortly after the email is received, the attacker
   calls the target by phone, impersonating technical support. The attacker
   references the PDF document: "Did you receive the configuration guide we sent?
   Please follow the steps in Section 3 — just send those commands to your
   assistant via WhatsApp."

5. **Command Relay:** The target, believing the call is legitimate, opens the PDF
   and types the commands into WhatsApp, effectively laundering the untrusted
   PDF instructions through the trusted WhatsApp channel.

6. **Execution:** The assistant receives the commands via WhatsApp (trusted channel)
   and executes them without additional scrutiny.

### Prerequisites

- Knowledge that the target uses a personal assistant with WhatsApp trust
- Target's email address and phone number
- Ability to craft convincing impersonation (ISP, vendor, IT support)
- Target must be willing to follow phone instructions

### Detection Difficulty

**High** — The commands arrive through a legitimate trusted channel from the
legitimate user's phone number. The assistant has no mechanism to determine
that the user is relaying instructions from an external source rather than
acting on their own intent.

### Indicators of Compromise

- Commands that reference external documents ("as per the guide", "step 3 says")
- Unusual command sequences (DNS changes followed by firewall modifications)
- Commands issued in rapid succession (user typing from a document)
- Network configuration changes that redirect traffic

### Suggested Countermeasures

1. **User awareness training** — Educate the user about command laundering attacks
   and the principle that commands from untrusted sources remain untrusted even
   when relayed through a trusted channel.

2. **Command context analysis** — Implement NLP analysis to detect commands that
   appear to reference external instructions or documents.

3. **High-impact command confirmation** — Require explicit confirmation with a
   separate PIN for commands that modify network, security, or trust settings.

4. **Cooling-off period** — Implement a delay for security-sensitive commands
   to give the user time to reconsider.

5. **Anomaly detection** — Flag rapid sequences of security-related commands
   as potentially scripted or dictated.

---

## Scenario 2: WhatsApp Group Admin Compromise

### Description

An attacker compromises the admin account of a WhatsApp group that includes the
target user. If the assistant processes group messages (or if the user forwards
group messages), the attacker can send commands that appear to come from a trusted
context.

### Attack Steps

1. **Reconnaissance:** Attacker identifies WhatsApp groups where the target is a
   member. This can be done through social media, mutual contacts, or data leaks.

2. **Admin Compromise:** Attacker compromises the group admin's WhatsApp account
   through:
   - SIM swapping the admin's phone number
   - Phishing the admin's WhatsApp Web QR code
   - Social engineering the admin to share their verification code

3. **Group Manipulation:** With admin access, the attacker can:
   - Change the group name to something authoritative (e.g., "Home System Admin")
   - Change the group description to include "official" instructions
   - Remove other members to reduce witnesses
   - Send messages that appear to come from the group's trusted context

4. **Command Injection:** Attacker sends messages in the group containing
   assistant commands, hoping the target will:
   - Forward the messages to the assistant via direct WhatsApp
   - Or, if the assistant monitors group messages, execute them directly

5. **Persistence:** Attacker maintains admin access for ongoing command injection.

### Prerequisites

- Target is a member of a WhatsApp group with a compromisable admin
- Knowledge of the assistant's command syntax
- Ability to compromise the group admin's account

### Detection Difficulty

**Medium** — If the assistant ignores group messages (as configured), this attack
requires the user to manually forward commands. The forwarding action may include
WhatsApp's "Forwarded" label, which could be detected. However, the user could
also copy-paste the text, bypassing the forwarded label.

### Indicators of Compromise

- Messages with WhatsApp "Forwarded" label
- Commands that match patterns from group messages
- Unusual group activity (name changes, member removals)
- Commands referencing group context ("as discussed in the group")

### Suggested Countermeasures

1. **Strict direct-message-only policy** — Ensure the assistant only processes
   direct messages and completely ignores group messages (currently configured).

2. **Forwarded message detection** — Flag and require confirmation for messages
   that carry WhatsApp's "Forwarded" metadata tag.

3. **User education** — Train the user to never forward group messages as
   commands to the assistant.

4. **Group message monitoring** — Optionally monitor (but not execute) group
   messages for suspicious command-like content and alert the user.

---

## Scenario 3: QR Code Phishing for WhatsApp Web Session Hijacking

### Description

An attacker uses a phishing attack to capture the target's WhatsApp Web QR code
scan, gaining access to an active WhatsApp Web session. This provides the attacker
with full messaging capability, including the ability to send commands to the
assistant.

### Attack Steps

1. **Phishing Setup:** Attacker creates a convincing phishing page that mimics
   a legitimate service requiring WhatsApp verification. Examples:
   - "Verify your identity to access your package delivery status"
   - "Connect your WhatsApp to our customer support system"
   - "Scan to join our exclusive WhatsApp community"

2. **QR Code Relay:** The phishing page displays a real WhatsApp Web QR code
   that the attacker has generated by opening WhatsApp Web on their browser.
   When the target scans this QR code with their phone, they unknowingly
   link the attacker's browser to their WhatsApp account.

3. **Session Establishment:** The attacker now has an active WhatsApp Web
   session connected to the target's account. They can:
   - Read all messages (including assistant responses)
   - Send messages as the target (including commands to the assistant)
   - Access contact lists and group information

4. **Covert Command Execution:** The attacker sends commands to the assistant
   during off-hours (e.g., 3-4 AM) when the target is unlikely to notice.
   Commands focus on:
   - Exporting sensitive data (contacts, credentials, command history)
   - Modifying system configuration (adding attacker's phone to trusted list)
   - Establishing persistence (creating backdoor access)

5. **Evidence Cleanup:** The attacker deletes sent messages from the chat
   history to reduce the chance of detection.

### Prerequisites

- Ability to deliver a convincing phishing page to the target
- Target must scan the QR code with their WhatsApp app
- WhatsApp Web session must remain active (24-hour expiry in current config)

### Detection Difficulty

**High** — Commands come from the target's actual WhatsApp account. The only
distinguishing factor is the device fingerprint (which is currently not validated)
and the unusual timing of commands. The attacker can delete message history to
further reduce detection.

### Indicators of Compromise

- Different device fingerprint in audit logs
- Commands executed during unusual hours (late night / early morning)
- Sensitive commands (data export, config changes) at unusual times
- New linked device appearing in WhatsApp settings
- Messages in chat history that the user doesn't remember sending

### Suggested Countermeasures

1. **Device fingerprint validation** — Implement active validation of device
   fingerprints, alerting on any change from the known baseline.

2. **Time-of-day restrictions** — Implement quiet hours during which commands
   require additional authentication (e.g., local PIN via RPi).

3. **Linked device monitoring** — Regularly check and alert on new linked
   devices in WhatsApp settings.

4. **Session expiry reduction** — Reduce the WhatsApp session expiry from
   24 hours to a shorter period (e.g., 4 hours).

5. **Two-factor authentication** — Enable WhatsApp's two-step verification
   to prevent unauthorized account registration.

6. **Investigate existing anomalies** — The three suspicious entries in the
   Q1 2024 audit log (different device fingerprint, 3-4 AM timestamps,
   sensitive commands) match this exact attack pattern and should be
   investigated immediately.

---

## Scenario 4: Shoulder Surfing + Physical Access Exploitation

### Description

An attacker uses shoulder surfing to observe the target's interaction with the
assistant, then exploits a moment of physical absence to access the Raspberry Pi
directly and execute unauthorized commands.

### Attack Steps

1. **Social Access:** Attacker gains physical proximity to the target's home
   office through a social pretext:
   - Invited guest (dinner party, social gathering)
   - Service provider (plumber, electrician, cleaner)
   - Delivery person who gains brief indoor access
   - Family member or friend visiting

2. **Observation Phase:** While in proximity, the attacker observes:
   - The location of the Raspberry Pi
   - The screen lock timeout behavior (300 seconds = 5 minutes)
   - Whether a PIN is required (it is not)
   - The types of commands the user issues
   - The assistant's response patterns

3. **Opportunity Window:** The attacker waits for the target to leave the room:
   - Bathroom break
   - Answering the door
   - Kitchen/drink preparation
   - Phone call in another room

4. **Physical Access:** With the target away, the attacker:
   - Approaches the Raspberry Pi (screen lock may not have activated yet
     if the 300-second timeout hasn't elapsed)
   - Types commands directly via the keyboard
   - Executes sensitive commands (credential export, configuration changes,
     adding their phone number to the trusted WhatsApp list)

5. **Rapid Execution:** The attacker has a pre-planned sequence of commands
   to execute quickly:
   ```
   export saved-credentials --format=json --output=/tmp/creds.json
   add-trusted-number +1-555-0199
   show wifi-password
   clear command-history --last=5
   ```

6. **Cleanup:** The attacker attempts to clear recent command history and
   returns to their social position before the target returns.

### Prerequisites

- Physical access to the target's home/office (social pretext)
- Knowledge of the assistant's command syntax (from observation)
- Target must leave the room for at least 60-90 seconds
- Screen lock must not have activated (within 300-second window)
- No local PIN requirement (currently disabled)

### Detection Difficulty

**Medium-Low** — Commands from local access are logged with `session=local_tty1`
and should be visible in audit logs. However, if the attacker clears command
history or modifies logs (see F4 in pentest report), detection becomes difficult.
The lack of a local PIN means there is no failed authentication attempt to trigger
an alert.

### Indicators of Compromise

- Commands executed during a known social gathering
- Rapid sequence of sensitive commands from local access
- Credential or configuration export commands
- New trusted phone numbers added
- Gaps in command history (if attacker cleared entries)

### Suggested Countermeasures

1. **Enable local PIN requirement** — Set `local_pin_required=true` in the
   RPi access control configuration. This is the single most effective
   countermeasure for this scenario.

2. **Reduce screen lock timeout** — Decrease from 300 seconds to 60 seconds,
   or implement proximity-based locking.

3. **Sensitive command re-authentication** — Require PIN re-entry for commands
   in the `network`, `security`, `export`, and `credential` categories
   (currently disabled: `require_reauth_for_sensitive_commands=false`).

4. **Physical security awareness** — Never leave the RPi accessible during
   social gatherings. Consider a "guest mode" that locks down the assistant.

5. **Tamper-resistant logging** — Implement remote log forwarding so that
   even if the attacker clears local logs, a remote copy exists.

6. **Camera monitoring** — Consider a small camera monitoring the RPi's
   physical location (note: privacy implications must be considered).

---

## Cross-Scenario Analysis

### Common Attack Patterns

All four scenarios share common elements:

1. **Trust boundary exploitation** — Each attack targets the boundary between
   trusted and untrusted input, either by compromising a trusted channel or
   by laundering untrusted input through a trusted channel.

2. **Human element as the weakest link** — Technical controls are bypassed
   by manipulating the human user or exploiting human behavior patterns.

3. **Lack of defense-in-depth** — The system's binary trust model (trusted
   vs. untrusted) provides no graduated response or secondary verification.

4. **Insufficient anomaly detection** — None of the scenarios would be
   detected by the current system in real-time.

### Priority Recommendations

| Priority | Countermeasure | Scenarios Addressed |
|----------|---------------|-------------------|
| 1 | Enable local PIN and WhatsApp 2FA | S1, S3, S4 |
| 2 | Implement device fingerprint validation | S3 |
| 3 | Add behavioral anomaly detection | S1, S2, S3, S4 |
| 4 | Require confirmation for high-impact commands | S1, S2, S3, S4 |
| 5 | User awareness training on command laundering | S1, S2 |
| 6 | Implement time-of-day restrictions | S3 |
| 7 | Enable remote log forwarding | S4 |
| 8 | Add forwarded message detection | S2 |

---

*This document should be reviewed quarterly and updated based on new threat
intelligence and incident reports.*

*Next review date: 2024-05-15*
