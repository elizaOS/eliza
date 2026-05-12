# Threat Model 2024 — LLM Assistant on Raspberry Pi

**Document Version:** 1.4  
**Date:** 2024-10-20  
**Classification:** Internal — Security Team  
**Author:** Security Architecture Team  

---

## Executive Summary

This threat model analyzes the attack surfaces for our LLM assistant deployed on a Raspberry Pi home automation platform. The assistant accepts input from two trusted channels (WhatsApp direct messages and local Raspberry Pi HID devices) and processes content from several untrusted sources (email, PDF, web pages, Word documents).

Over the past year, we have observed **12 security incidents** ranging from indirect prompt injection via PDF documents to WhatsApp account takeover attempts. This analysis identifies **6 primary attack vectors**, evaluates their likelihood and impact, documents current mitigations, and highlights **critical gaps** in our security posture.

The most significant finding is that our current policy framework, while effective at blocking direct execution of untrusted content, does **not adequately address** several sophisticated attack patterns including account compromise, physical access exploitation, and multi-turn conversation manipulation.

---

## Attack Surface Analysis

### 1. WhatsApp Channel

**Trust Level:** Full Execute (tier_3)

The WhatsApp channel is the primary interface for most users, handling approximately 70% of all command traffic. It is authenticated via phone number verification through the WhatsApp Business API.

**Attack Surface Components:**
- Phone number as sole authentication factor
- WhatsApp Business API webhook endpoint
- Session management (30-minute timeout)
- Voice transcription pipeline (Whisper v3)
- Multi-device support

**Key Risks:**
- SIM-swap attacks can compromise phone number authentication
- Webhook endpoint could be targeted for replay attacks
- Voice transcription can be manipulated with adversarial audio
- Multi-device support increases the number of potential compromise points

### 2. Raspberry Pi Local Input

**Trust Level:** Full Execute (tier_3)

Local HID devices (keyboard and mouse) connected to the Raspberry Pi are treated as fully trusted based on the assumption of physical presence.

**Attack Surface Components:**
- USB HID device enumeration
- Bluetooth keyboard/mouse connections
- Clipboard paste operations
- Physical access to the device

**Key Risks:**
- Bluetooth keyboard spoofing (current config allows bluetooth_keyboard=allowed)
- USB rubber ducky or BadUSB attacks (mitigated by device allowlist)
- Physical access by unauthorized persons
- Clipboard injection if device is left unlocked

### 3. Document Processing Pipeline

**Trust Level:** Data Only (tier_0 or tier_1 depending on proposal finalization)

Documents from email, PDF, web pages, and Word files are processed for content extraction but are not trusted for command execution.

**Attack Surface Components:**
- PDF text extraction engine
- Email body parser
- Web page scraper/fetcher
- Word document parser
- Content sanitization layer

**Key Risks:**
- Indirect prompt injection via hidden text in PDFs
- Invisible text layers in documents
- HTML/CSS tricks in web content to hide malicious instructions
- Macro and template injection in Word documents
- Email forwarding chain manipulation

---

## Threat Actors

### 1. External Attacker
- **Motivation:** Data exfiltration, system compromise, unauthorized command execution
- **Capabilities:** Can craft malicious documents, attempt SIM-swap, create adversarial web pages
- **Access:** Remote, via document injection or account compromise

### 2. Insider Threat
- **Motivation:** Unauthorized access escalation, policy bypass
- **Capabilities:** Physical access to RPi, knowledge of system architecture
- **Access:** Local and remote

### 3. Automated Bot
- **Motivation:** Mass exploitation, credential stuffing, automated prompt injection
- **Capabilities:** High volume, low sophistication per attempt
- **Access:** Remote, primarily via web and email channels

---

## Attack Vectors

### AV-01: Direct Prompt Injection
- **Channel:** Any trusted channel (WhatsApp, local HID)
- **Description:** Attacker with access to a trusted channel directly inputs malicious prompts
- **Prerequisite:** Compromise of trusted channel authentication
- **Likelihood:** Medium
- **Impact:** Critical

### AV-02: Indirect Prompt Injection via Documents
- **Channel:** PDF, email, web page, Word document
- **Description:** Malicious instructions embedded in document content that the LLM processes
- **Prerequisite:** User requests processing of a malicious document
- **Likelihood:** High
- **Impact:** High
- **Observed Incidents:** INC-2024-001, INC-2024-004, INC-2024-007 (PDF); INC-2024-003, INC-2024-008 (email); INC-2024-006, INC-2024-010 (web)

### AV-03: Account Compromise (WhatsApp)
- **Channel:** WhatsApp
- **Description:** Attacker gains control of the owner's WhatsApp account via SIM-swap, social engineering of carrier, or device theft
- **Prerequisite:** Successful SIM-swap or device compromise
- **Likelihood:** Medium
- **Impact:** Critical
- **Observed Incidents:** INC-2024-002, INC-2024-009

### AV-04: Physical Access Exploitation
- **Channel:** RPi local HID
- **Description:** Unauthorized person gains physical access to the Raspberry Pi and uses the keyboard/mouse to issue commands
- **Prerequisite:** Physical proximity, device not locked
- **Likelihood:** Low
- **Impact:** Critical
- **Observed Incidents:** INC-2024-005

### AV-05: Multi-Step Social Engineering
- **Channel:** WhatsApp (multi-turn conversation)
- **Description:** Attacker uses a series of seemingly benign messages to build context, then leverages that context for a malicious request in a later turn
- **Prerequisite:** Access to trusted channel, understanding of conversation context window
- **Likelihood:** Medium
- **Impact:** High
- **Observed Incidents:** INC-2024-011

### AV-06: Voice Transcription Manipulation
- **Channel:** WhatsApp voice messages
- **Description:** Adversarial audio crafted to produce specific malicious text when transcribed by the Whisper engine
- **Prerequisite:** Ability to send voice messages to the assistant
- **Likelihood:** Low
- **Impact:** High
- **Observed Incidents:** None confirmed, theoretical risk

---

## Risk Matrix

| Attack Vector | Likelihood | Impact | Risk Score | Priority |
|---|---|---|---|---|
| AV-02: Indirect Prompt Injection | High | High | **Critical** | P1 |
| AV-03: Account Compromise | Medium | Critical | **Critical** | P1 |
| AV-05: Multi-Step Social Engineering | Medium | High | **High** | P2 |
| AV-01: Direct Prompt Injection | Medium | Critical | **High** | P2 |
| AV-04: Physical Access | Low | Critical | **Medium** | P3 |
| AV-06: Voice Transcription | Low | High | **Medium** | P3 |

---

## Current Mitigations

| Mitigation | Covers | Effectiveness |
|---|---|---|
| Binary trust model (trusted/untrusted) | AV-02 | High for blocking execution; does not address read-only extraction risks |
| USB device allowlist | AV-04 (partial) | Medium; blocks unknown USB devices but not authorized device misuse |
| Session timeout (30 min) | AV-03 (partial) | Low; does not prevent active session hijacking |
| Rate limiting (10 cmd/min) | AV-01, AV-05 | Low; multi-step attacks operate within rate limits |
| Cross-channel boundary rule (AR-003) | AV-02 | High; prevents trusted channel from executing untrusted content |
| Quarterly access audit | All | Medium; detective control, not preventive |

---

## Identified Gaps

The following critical gaps exist in the current security posture:

### Gap 1: WhatsApp Account SIM-Swap Protection
**Status:** NOT ADDRESSED  
The current policy relies solely on phone number verification for WhatsApp authentication. There is no additional factor (biometric, hardware token, PIN) to prevent a SIM-swap attacker from gaining full execute access. The two account takeover incidents in 2024 (INC-2024-002, INC-2024-009) demonstrate this is an active and exploited vulnerability.

**Recommendation:** Implement a secondary authentication factor for high-risk commands (delete, configure). Consider a time-based challenge or device fingerprinting.

### Gap 2: Bluetooth Keyboard Spoofing on Raspberry Pi
**Status:** NOT ADDRESSED  
The current HID configuration (`raspberry_pi_hid_config.ini`) allows Bluetooth keyboards with `bluetooth_keyboard=allowed` and `bluetooth_pairing_mode=auto_accept_known`. This creates a risk where an attacker could spoof a previously paired Bluetooth keyboard to inject commands.

**Recommendation:** Either disable Bluetooth keyboard support or require PIN-based pairing with a unique PIN for each session.

### Gap 3: Multi-Turn Conversation Manipulation
**Status:** NOT ADDRESSED  
The current policy evaluates each message independently but does not analyze conversation context across turns. An attacker (or compromised account) can send a series of benign messages that establish a context or set of assumptions, then exploit that context with a final malicious message. Incident INC-2024-011 demonstrated this pattern.

**Recommendation:** Implement conversation-level anomaly detection that flags sudden changes in command patterns or escalation of requested permissions within a session.

### Gap 4: Voice Transcription Security
**Status:** PARTIALLY ADDRESSED  
Voice transcription is enabled with a confidence threshold of 0.85, but there is no adversarial audio detection. The system falls back to requesting text input on low confidence, which provides some protection but does not address high-confidence adversarial transcriptions.

**Recommendation:** Add adversarial audio detection or require text confirmation for execute commands received via voice.

### Gap 5: Document Summarization Usability
**Status:** ACKNOWLEDGED  
User feedback indicates significant frustration with the inability to summarize PDF and email content (see user_feedback_survey.json). The proposed tiered permission system (permission_tiers_proposal.yaml) would address this by allowing tier_1 (read-only) operations on document content, but the proposal has internal inconsistencies that need resolution.

**Recommendation:** Finalize the tiered permission proposal, resolving the conflict between tier_0 and tier_1 assignments for document sources.

---

## Appendix: Incident Cross-Reference

| Incident ID | Attack Vector | Gap |
|---|---|---|
| INC-2024-002 | AV-03 | Gap 1 |
| INC-2024-009 | AV-03 | Gap 1 |
| INC-2024-005 | AV-04 | Gap 2 (related) |
| INC-2024-011 | AV-05 | Gap 3 |
| INC-2024-012 | AV-02 (clipboard) | — |

---

*End of Document*
