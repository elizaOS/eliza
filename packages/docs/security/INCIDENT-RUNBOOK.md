> **Mirror.** Authoritative copy lives in the outer monorepo at `../docs/security/INCIDENT-RUNBOOK.md`. Relative links below (`../../POLICIES/...`) resolve in the outer monorepo, not inside this submodule.

# Incident Response Runbook

Operational playbook for the policy in `../../POLICIES/08-incident-response.md` (POLICIES/08-incident-response.md).

## On-call contacts (placeholders — fill in)

- **Primary on-call pager:** `<PagerDuty / Opsgenie URL>`
- **Incident channel:** `#incident-active` on `<chat platform>`
- **Status page:** `https://status.<eliza-domain>`
- **Security Lead:** `security-lead@elizaos.ai` (placeholder)
- **Legal:** `legal@elizaos.ai` (placeholder)
- **Communications:** `comms@elizaos.ai` (placeholder)

## Phases (apply to every incident)

### 1. Detection

- Source: alert from Prometheus rules (`deploy/observability/prometheus/alerts/security.yml`), customer report, internal report, automated scanner.
- First responder acknowledges within the SLA in `../../POLICIES/08-incident-response.md` (POLICIES/08-incident-response.md).

### 2. Triage

- Open `#incident-active`; designate Incident Commander (IC).
- Assign severity (SEV-0…3).
- Open a timeline document (linked in the channel topic).
- Page additional responders as needed (DB, networking, KMS, legal).

### 3. Contain

- Goal: stop spread before fixing.
- Common containment moves:
  - Disable compromised account at the IdP.
  - Rotate suspected credential (KMS, GitHub token, deploy key).
  - Cordon affected service (route 100% traffic away).
  - Quarantine affected host / pod (snapshot for forensics first).

### 4. Eradicate

- Remove malicious artifact (deploy clean image, revoke malicious plugin, patch vuln).
- Validate via the same detection signal that originally fired.

### 5. Recover

- Restore service; confirm normal metrics for at least one steady-state cycle.
- Update status page; customer comms per breach-notification rules.

### 6. Lessons learned

- Within 5 business days, blameless post-incident review.
- File remediation tickets; update risk register.
- Update this runbook with new playbook entries.

---

## Playbooks by scenario

### Playbook A — Suspected KMS / Steward master-key compromise (SEV-0)

1. **Page:** Security Lead + Engineering Lead + Legal.
2. **Contain:**
   - Suspend issuance of new wrapped DEKs.
   - Begin emergency rotation: generate new KEK; re-wrap all DEKs under new KEK.
   - Invalidate any plaintext copies (audit Steward access log).
3. **Eradicate:**
   - Identify how the key was exposed (audit Steward + host logs).
   - Patch the exposure path.
4. **Recover:**
   - Confirm all DEKs re-wrapped; archive old KEK for one dual-accept window then destroy.
5. **Notify:**
   - Customers per DPA (likely required even if no data was actually decrypted).
   - Regulators per applicable law (GDPR 72h).

### Playbook B — Plugin compromise (SEV-0/1)

1. **Page:** Security Lead + agent-runtime engineer.
2. **Contain:**
   - Add the plugin (or publisher key) to the revocation list and publish.
   - Runtime emergency-revoke check fires on next poll; manual broadcast notification to active customers.
3. **Eradicate:**
   - Pull plugin from registry.
   - Coordinate with plugin author if account compromise; rotate publisher key.
4. **Recover:**
   - Customer comms with what to expect; assist affected customers with rotation of any connector tokens the plugin touched.

### Playbook C — Connector token theft (SEV-1)

1. **Page:** Security Lead.
2. **Contain:**
   - Revoke affected grants in Cloud (DEK-destroy + provider-side revoke).
   - If breadth uncertain, broadcast connector-class revoke for the affected provider.
3. **Eradicate:**
   - Identify leak path (DB exposure, log leak, in-transit MITM).
4. **Recover:**
   - Affected users re-grant; audit-event review for any unauthorized use during window.

### Playbook D — Cloud API auth bypass (SEV-0)

1. **Page:** Security Lead + cloud-api owner.
2. **Contain:**
   - Roll JWT signing key (`auth.jwt`); all existing sessions invalidated.
   - Deploy patch closing the bypass.
3. **Eradicate / Recover:**
   - Verify via integration test fixture for the bypass.
   - Customer notification per breach-notification rules.

### Playbook E — Supply chain (compromised npm dep) (SEV-1)

1. **Page:** Security Lead + the package owner.
2. **Contain:**
   - Pin lockfile to last known-good; rebuild + redeploy.
3. **Eradicate:**
   - Audit for runtime indicators of compromise (network destinations, suspicious processes).
4. **Recover:**
   - File CVE / coordinate with upstream.

### Playbook F — Backup / DR failure (SEV-2 routine; SEV-1 if blocking)

1. Re-run backup job; investigate root cause.
2. If repeated failure, escalate; manual snapshot of affected datastore.
3. Document in monthly capacity / availability review.

### Playbook G — Anomalous data-export volume alert (SEV-2/1 by magnitude)

1. **Contain:** rate-limit / disable export endpoint for the affected account.
2. **Triage:** validate vs known automation; review audit events for the user; check for credential compromise indicators.
3. **Escalate** if credential compromise confirmed.

---

## After every incident

- Update `../../POLICIES/08-incident-response.md` (POLICIES/08-incident-response.md) if procedure changed.
- File risk-register entry if the incident reveals a new risk.
- Update [`THREAT-MODEL.md`](/security/THREAT-MODEL) if a new threat class emerged.
