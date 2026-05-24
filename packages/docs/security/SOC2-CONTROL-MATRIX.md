> **Mirror.** Authoritative copy lives in the outer milady monorepo at `milady/docs/security/SOC2-CONTROL-MATRIX.md`. Relative links below (`../../POLICIES/...`) resolve in the outer monorepo, not inside this submodule.

# SOC2 Control Matrix — Eliza Stack

This matrix maps every in-scope Trust Service Criterion to: the binding policy in [`../../POLICIES/`](../../POLICIES/), the code location(s) implementing the control, and the evidence collection method.

Status: **scaffolding**. Some implementation references are aspirational and tracked in [`audits/PLAN.md`](audits/PLAN.md).

## Legend

- **Policy** — link to `POLICIES/NN-name.md`.
- **Code** — primary source path or service.
- **Evidence** — what an auditor will see / how it is collected.
- **State** — `In place` / `Partial` / `Planned`.

## CC1 — Control Environment

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| CC1.1 Integrity & ethics | [01](../../POLICIES/01-information-security.md), [17](../../POLICIES/17-code-of-conduct.md) | HR onboarding | Signed acknowledgments | Planned |
| CC1.2 Board oversight | [01](../../POLICIES/01-information-security.md) | Quarterly review | Meeting minutes | Planned |
| CC1.3 Org structure | [01](../../POLICIES/01-information-security.md) | Org chart | HR system export | Planned |
| CC1.4 Hiring screening | [18](../../POLICIES/18-onboarding-offboarding.md) | Background check | HR records | Planned |
| CC1.5 Accountability | [17](../../POLICIES/17-code-of-conduct.md) | Disciplinary process | HR records | Planned |

## CC2 — Communication & Information

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| CC2.1 Internal | [01](../../POLICIES/01-information-security.md) | All-hands, training | Training records | Planned |
| CC2.2 External (reports in) | [21](../../POLICIES/21-responsible-disclosure.md) | `/.well-known/security.txt`, security@ | URL, inbox audit | Partial |
| CC2.3 External (commitments out) | [20](../../POLICIES/20-terms-dpa-subprocessors.md), [19](../../POLICIES/19-privacy.md) | Public ToS / Privacy / Subprocessor URLs | Web pages versioned | Partial |

## CC3 — Risk Assessment

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| CC3.1 Risk register | [07](../../POLICIES/07-risk-assessment.md) | GRC tool / `docs/security/risk-register.md` | Quarterly snapshot | Planned |
| CC3.2 Fraud risk | [07](../../POLICIES/07-risk-assessment.md) | Billing review | Review minutes | Planned |
| CC3.3 Vendor risk | [06](../../POLICIES/06-vendor-management.md) | Vendor register | DPA + SOC2 on file | Partial |
| CC3.4 Change-impact risk | [05](../../POLICIES/05-change-management.md) | PR template | PR history | Partial |

## CC4 — Monitoring Activities

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| CC4.1 Continuous monitoring | [14](../../POLICIES/14-logging-monitoring.md) | OTel + Prometheus + Loki, Grafana | Dashboards, alert history | Planned |
| CC4.2 Internal audit | [01](../../POLICIES/01-information-security.md) | Quarterly SDLC + access review | Review artifacts | Planned |

## CC5 — Control Activities

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| CC5.1 Selection | This matrix | n/a | This file | In place |
| CC5.2 Technology controls | [02](../../POLICIES/02-access-control.md), [12](../../POLICIES/12-cryptography.md) | IdP, KMS, firewalls | Config exports | Partial |
| CC5.3 Policies | All `POLICIES/` | n/a | `POLICIES/` directory | In place |

## CC6 — Logical & Physical Access

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| CC6.1 IAM + MFA | [02](../../POLICIES/02-access-control.md) | IdP (Google/Okta) | IdP audit log | Planned |
| CC6.2 Provisioning | [18](../../POLICIES/18-onboarding-offboarding.md) | Onboarding ticket | Ticket history | Planned |
| CC6.3 RBAC, least privilege | [02](../../POLICIES/02-access-control.md) | IAM roles in cloud account | Role bindings export | Partial |
| CC6.4 Physical | [04](../../POLICIES/04-asset-management.md) | Hosting subservice SOC2 | Vendor reports | Inherited |
| CC6.5 Secure disposal | [04](../../POLICIES/04-asset-management.md), [11](../../POLICIES/11-data-retention.md) | Wipe SOP, DEK-destroy | Disposal records, audit events | Planned |
| CC6.6 Network boundary | [02](../../POLICIES/02-access-control.md) | Cloud security groups, private subnets | IaC + provider config | Partial |
| CC6.7 Encryption in transit | [12](../../POLICIES/12-cryptography.md) | TLS termination, mTLS | TLS labs scan | Partial |
| CC6.8 Anti-malware / integrity | [04](../../POLICIES/04-asset-management.md), [16](../../POLICIES/16-secure-development.md), [24](../../POLICIES/24-plugin-connector-trust.md) | Endpoint AV, CI scanning, plugin signing | Scan reports, signatures | Partial |

## CC7 — System Operations

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| CC7.1 Vuln scanning + log aggregation | [14](../../POLICIES/14-logging-monitoring.md), [15](../../POLICIES/15-vulnerability-management.md) | CI scanners + OTel + Loki | Scan + log dashboards | Planned |
| CC7.2 Anomaly detection | [14](../../POLICIES/14-logging-monitoring.md) | `prometheus/alerts/security.yml` | Alert history | Planned |
| CC7.3 Incident eval | [08](../../POLICIES/08-incident-response.md) | Sev classes | IR records | Planned |
| CC7.4 IR plan | [08](../../POLICIES/08-incident-response.md), [`INCIDENT-RUNBOOK.md`](INCIDENT-RUNBOOK.md) | Runbook + tabletop | Tabletop record | Planned |
| CC7.5 Recovery | [09](../../POLICIES/09-business-continuity.md), [13](../../POLICIES/13-backup.md) | DR test | DR test report | Planned |

## CC8 — Change Management

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| CC8.1 SDLC | [05](../../POLICIES/05-change-management.md), [16](../../POLICIES/16-secure-development.md) | Branch protection, CI gates | PR + CI history | Partial |

## CC9 — Risk Mitigation

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| CC9.1 BC/DR | [09](../../POLICIES/09-business-continuity.md) | DR test | DR test report | Planned |
| CC9.2 Vendor lifecycle | [06](../../POLICIES/06-vendor-management.md) | Vendor register | DPA / SOC2 on file | Partial |

## A1 — Availability

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| A1.1 Capacity | [09](../../POLICIES/09-business-continuity.md) | Provider metrics + Prometheus | Capacity reports | Planned |
| A1.2 Backups | [13](../../POLICIES/13-backup.md) | Backup jobs | Job metrics + restore-test | Planned |
| A1.3 DR with RTO/RPO | [09](../../POLICIES/09-business-continuity.md) | Runbook | DR test report | Planned |

## C1 — Confidentiality

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| C1.1 Encryption at rest | [10](../../POLICIES/10-data-classification.md), [12](../../POLICIES/12-cryptography.md) | `@elizaos/security`, Steward | KMS audit log | Partial |
| C1.2 Secure disposal | [11](../../POLICIES/11-data-retention.md), [22](../../POLICIES/22-data-subject-request.md) | DEK-destroy pipeline | Audit events | Planned |

## PI1 — Processing Integrity

| Criterion | Policy | Code / Process | Evidence | State |
|---|---|---|---|---|
| PI1.1 Input validation | [16](../../POLICIES/16-secure-development.md) | Route schemas (Zod / equivalent) | Schema export | Partial |
| PI1.2 Complete / accurate / timely processing | [05](../../POLICIES/05-change-management.md) | Billing use cases | Billing reconciliation reports | Planned |
| PI1.3 Output review | [16](../../POLICIES/16-secure-development.md) | Code review on billing math | PR history | Partial |
| PI1.4 Input integrity | [10](../../POLICIES/10-data-classification.md) | KMS-encrypted with AAD | Sample decrypts | Partial |
| PI1.5 Output delivery | [14](../../POLICIES/14-logging-monitoring.md) | Idempotent delivery + audit | Delivery logs | Planned |

## Eliza-specific control surface

| Concern | Policy | Code / Process | Evidence |
|---|---|---|---|
| Plugin trust | [24](../../POLICIES/24-plugin-connector-trust.md) | Sigstore manifests + sandboxed workers | Signature verify logs |
| AI model integrity | [23](../../POLICIES/23-ai-ml-model-governance.md) | `model_lineage.json` + Cosign | Lineage manifests |
| DSPy prompt integrity | [23](../../POLICIES/23-ai-ml-model-governance.md) | HMAC in `OptimizedPromptService` | HMAC keys, fail-closed test |
| Connector tokens | [10](../../POLICIES/10-data-classification.md), [24](../../POLICIES/24-plugin-connector-trust.md) | KMS-encrypted with AAD | Token store sample |
| Sub-agent coding sessions | [16](../../POLICIES/16-secure-development.md) | PTY telemetry | Spawn audit events |
