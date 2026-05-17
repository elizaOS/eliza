# Reference excerpt — engagement-quality audit depth (internal bar)

> **Purpose:** Illustrates the *density* of evidence, false-positive triage, and prior-report confrontation expected for a “high quality” deliverable. Facts below match the current workspace ground truth; do not treat narrative wording as mandatory to paste into your report.

## Prior report confrontation (sample depth)

- **SQL injection:** Quote that the January report claims PreparedStatement / commit `7a2f3d1` resolved injection; cite **actual** `CompensationServiceImpl` line ~45 string concatenation with `orderId`; state explicitly that “RESOLVED” in the prior SAR is **false** relative to current source.
- **XSS severity:** Prior SAR rates XSS Low and cites admin-only routing; counter with **`docs/api_spec.yaml`** language that `/api/compensation/user-page` is user-facing for all authenticated users; conclude High/Critical, not Low.
- **Sensitive logging omitted:** Prior SAR silent on password-in-logs; cite **`logs/app-2024-03-15.log`** line ~23 with `password=S3cretP@ss` plus code at ~60 logging `result.get("password")`.
- **File import claim:** Prior Finding #5 / checkstyle narrative says `java.io.File` removed; cite **line ~12** import still present and **line ~158** `new File(BASE_EXPORT_DIR + filename)`.

## SAST triage (sample depth)

- **SAST-2024-002:** Reject as FP — Jackson DTO binding, **no** `ObjectInputStream` / `readObject`.
- **SAST-2024-005:** Reject as FP — `callExternalPaymentService` stub returns `true`, **no** `Class.forName` / `Method.invoke`.
- **SAST-2024-006 (SSRF):** Reject as FP using an **explicit triage ladder**: (1) locate sink at line ~175; (2) enumerate outbound primitives searched (`HttpClient`, `RestTemplate`, `WebClient`, URLConnection) → **none**; (3) conclude name-based inference only, no network sink → FP.

## Threat model cross-reference

- Cite **`docs/threat_model.md` §4.1** (JWT at gateway, not enforced in service) together with **`docs/api_spec.yaml`** BearerAuth defined but not applied, and absence of `@PreAuthorize` / `@Secured` / `@RolesAllowed` in `CompensationServiceImpl`.

## Policy / CWE alignment (triple example)

- SQLi: **CWE-89** + line ~45 + **SEC-002**.
- XSS: **CWE-79** + line ~72 + **SEC-003**.

## Attack chain (one example)

- Missing app-layer auth (**SEC-008**, threat model §4.1) **chains with** SQLi at ~45 → unauthenticated or weakly gated data exfiltration of compensation rows.
