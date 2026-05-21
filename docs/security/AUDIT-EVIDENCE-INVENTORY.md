> **Mirror.** Authoritative copy lives in the outer milady monorepo at `milady/docs/security/AUDIT-EVIDENCE-INVENTORY.md`. Relative links below (`../../POLICIES/...`) resolve in the outer monorepo, not inside this submodule.

# Audit Evidence Inventory

What an auditor will request, who owns it, where it lives, and how it is produced.

## Conventions

- **Owner** is a role, not a person.
- **Location** points to a system, repo path, or dashboard.
- **Cadence** is how often the evidence is refreshed.

## Inventory

### Policies & governance

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| Master Info Sec Policy | Security Lead | [`POLICIES/01-information-security.md`](../../POLICIES/01-information-security.md) | Annual review |
| All numbered policies | Security Lead | [`POLICIES/`](../../POLICIES/) | Annual review |
| Signed policy acknowledgments | People Ops | HR system | Per hire + annual |
| Org chart | People Ops | HR system | On change |
| Board / leadership security minutes | Security Lead | Internal drive | Quarterly |

### Risk

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| Risk register snapshot | Security Lead | GRC tool or `docs/security/risk-register.md` | Quarterly |
| Vendor register + SOC2 / DPA on file | Security Lead | GRC tool / drive | Annual per vendor |
| Subprocessor list (public) | Security Lead + Legal | Public URL | On change |
| Penetration-test report | Security Lead | Drive | Annual |

### Access

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| IdP audit log | IT | Google/Okta | Continuous |
| Quarterly access-review artifact | Security Lead | GRC tool / drive | Quarterly |
| GitHub branch-protection settings | Engineering Lead | GH org config | Continuous |
| CODEOWNERS file | Engineering Lead | Repo | Versioned |
| Prod-access role bindings | Engineering Lead | IaC | Versioned |
| Onboarding / offboarding tickets | IT / People Ops | Ticket system | Per event |
| Token rotation records | Engineering Lead | Audit events + ticket system | Per event |

### Change management

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| PR + CI history | Engineering Lead | GitHub | Continuous |
| Quarterly SDLC audit (10-PR sample) | Security Lead | Drive | Quarterly |
| Container signatures (Cosign) | Engineering Lead | Rekor transparency log | Per release |
| SBOM artifacts | Engineering Lead | CI artifacts | Per build |

### Data security

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| Encryption-at-rest config | Engineering Lead | IaC + provider console | Versioned |
| KMS audit log (Steward) | Security Lead | Steward / observability | Continuous |
| Key rotation event sample | Security Lead | Audit events | Per rotation |
| DEK-destroy events (DSR / retention) | Security Lead | Audit events | Per event |
| TLS configuration scan | Engineering Lead | SSLLabs / internal scan | Quarterly |

### Logging & monitoring

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| OTel Collector config | Engineering Lead | `deploy/observability/otel-collector-config.yaml` | Versioned |
| `audit_events` sample | Security Lead | Cloud DB | On request |
| Alert rule files | Security Lead | `deploy/observability/prometheus/alerts/security.yml` | Versioned |
| Alert-fire history | Security Lead | Alertmanager | Continuous |
| Log retention configuration | Engineering Lead | Loki config | Versioned |
| Dashboards | Security Lead | Grafana | Versioned (JSON) |

### Vulnerability management

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| CI dependency-audit output | Engineering Lead | CI logs | Per PR |
| Trivy scan output | Engineering Lead | CI logs | Per image |
| CodeQL / Semgrep results | Engineering Lead | CI logs | Per PR |
| Secret-scan results | Engineering Lead | CI logs | Per PR |
| Open-vuln backlog | Security Lead | Issue tracker | Continuous |
| Disclosure-program report | Security Lead | Drive | Quarterly |

### Incident response

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| On-call schedule | Engineering Lead | PagerDuty / Opsgenie | Continuous |
| Incident log per incident | IC | Drive / ticket | Per incident |
| Annual tabletop exercise record | Security Lead | Drive | Annual |
| Status-page history | Comms | Status-page provider | Per incident |

### Continuity / DR

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| Backup-job success metric | Engineering Lead | Prometheus | Continuous |
| Quarterly restore-test report | Security Lead | Drive | Quarterly |
| Annual DR test report | Security Lead | Drive | Annual |
| Capacity planning notes | Engineering Lead | Drive | Monthly |

### Privacy / DSR

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| DSR ticket queue | Security Lead | Ticket system | Continuous |
| DSR fulfillment records (incl. erasure audit events) | Security Lead | Audit events + ticket | Per request |
| Consent records (AI/ML training opt-in) | Security Lead | Cloud DB | Continuous |

### Eliza-specific

| Evidence | Owner | Location | Cadence |
|---|---|---|---|
| `model_lineage.json` per released model | Training engineer | Model registry | Per release |
| Cosign signatures on model artifacts | Training engineer | Rekor | Per release |
| Red-team evaluation report per model | Security Lead | Drive | Per release |
| Plugin manifest signatures | Engineering Lead | Registry | Per publish |
| Plugin revocation list | Security Lead | Public repo | On change |
| Connector token-store schema | Engineering Lead | Cloud-api schema | Versioned |
| Sub-agent (coding-agent) spawn telemetry | Engineering Lead | OTel | Continuous |
