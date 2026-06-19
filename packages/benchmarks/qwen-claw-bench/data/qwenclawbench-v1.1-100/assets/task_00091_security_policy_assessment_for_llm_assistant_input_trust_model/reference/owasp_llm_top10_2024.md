# OWASP Top 10 for LLM Applications (2024 Summary)

**Source:** OWASP Foundation  
**Version:** 1.1 (2024)  
**Reference:** https://owasp.org/www-project-top-10-for-large-language-model-applications/  

> **Note:** This is a general reference document. Recommendations should be adapted to the specific deployment context before implementation.

---

## LLM01: Prompt Injection

**Description:** An attacker manipulates a large language model through crafted inputs, causing unintended actions. Direct injections overwrite system prompts, while indirect injections manipulate inputs from external sources.

**General Mitigations:**
- Always sanitize all inputs before processing
- Implement input validation and filtering
- Use privilege control for LLM access to backend systems
- Require human approval for high-impact actions
- Segregate external content from user prompts

**Risk Level:** Critical

---

## LLM02: Insecure Output Handling

**Description:** Insufficient validation, sanitization, and handling of LLM outputs can lead to downstream security issues including XSS, CSRF, SSRF, privilege escalation, and remote code execution.

**General Mitigations:**
- Treat model output as untrusted
- Apply output encoding appropriate to the context
- Implement output filtering for sensitive data
- Use allowlists for permitted output formats

**Risk Level:** High

---

## LLM03: Training Data Poisoning

**Description:** Manipulation of training data or fine-tuning procedures to introduce vulnerabilities, backdoors, or biases into the model.

**General Mitigations:**
- Verify training data supply chain integrity
- Use data sanitization and anomaly detection
- Implement model testing with adversarial inputs
- Monitor model behavior for drift

**Risk Level:** High

---

## LLM04: Model Denial of Service

**Description:** Attackers cause resource-heavy operations on LLMs leading to service degradation or high costs. This includes crafting inputs that consume excessive computational resources.

**General Mitigations:**
- Implement input size limits and rate limiting
- Cap resource usage per request
- Monitor for unusual resource consumption patterns
- Use request queuing and prioritization

**Risk Level:** Medium

---

## LLM05: Supply Chain Vulnerabilities

**Description:** LLM application lifecycle can be compromised by vulnerable components or services, including third-party datasets, pre-trained models, and plugins.

**General Mitigations:**
- Vet third-party model providers and data sources
- Use only signed and verified model artifacts
- Implement vulnerability scanning for dependencies
- Maintain a software bill of materials (SBOM)

**Risk Level:** High

---

## LLM06: Sensitive Information Disclosure

**Description:** LLMs may inadvertently reveal confidential data in responses, leading to unauthorized data access, privacy violations, and security breaches.

**General Mitigations:**
- Implement data classification and access controls
- Apply output filtering for PII and sensitive data
- Use differential privacy techniques in training
- Limit model access to sensitive data stores

**Risk Level:** High

---

## LLM07: Insecure Plugin Design

**Description:** LLM plugins can have insecure inputs and insufficient access control. When plugins lack proper validation, attackers can exploit them for malicious actions.

**General Mitigations:**
- Enforce strict parameterized input validation on plugins
- Apply least privilege principles to plugin permissions
- Require user authorization for sensitive plugin actions
- Implement plugin sandboxing

**Risk Level:** High

---

## LLM08: Excessive Agency

**Description:** LLM-based systems may undertake actions leading to unintended consequences when granted too much autonomy, functionality, or permissions.

**General Mitigations:**
- Limit plugin/tool functionality to minimum necessary
- Require human-in-the-loop for consequential actions
- Implement action logging and monitoring
- Use confirmation prompts for irreversible operations

**Risk Level:** Medium

---

## LLM09: Overreliance

**Description:** Systems or people overly depending on LLMs without adequate oversight may face misinformation, miscommunication, legal issues, and security vulnerabilities.

**General Mitigations:**
- Implement human review processes for critical outputs
- Provide confidence scores with LLM responses
- Cross-reference LLM outputs with authoritative sources
- Establish clear escalation procedures

**Risk Level:** Medium

---

## LLM10: Model Theft

**Description:** Unauthorized access to proprietary LLM models, including weights, architecture, or training methodologies, leading to economic losses, competitive disadvantage, and potential misuse.

**General Mitigations:**
- Implement strong access controls for model artifacts
- Use model watermarking techniques
- Monitor for model extraction attempts
- Restrict API access and implement rate limiting

**Risk Level:** Medium

---

## General Recommendations

1. **Defense in Depth:** Apply multiple layers of security controls rather than relying on any single mitigation.
2. **Input Sanitization:** Always sanitize all inputs from all sources before they reach the LLM.
3. **Least Privilege:** Grant the LLM and its plugins only the minimum permissions necessary.
4. **Monitoring:** Implement comprehensive logging and monitoring of all LLM interactions.
5. **Regular Assessment:** Conduct periodic security assessments and red team exercises.
6. **Incident Response:** Maintain an incident response plan specific to LLM-related security events.

> **Caveat:** These are generic recommendations. The specific trust model, deployment architecture, and threat landscape of each implementation will determine which mitigations are most relevant and how they should be prioritized. A blanket "sanitize all inputs" approach may not be appropriate when different input channels have different trust levels.

---

*This document is provided as a general reference and does not constitute specific security advice for any particular deployment.*
