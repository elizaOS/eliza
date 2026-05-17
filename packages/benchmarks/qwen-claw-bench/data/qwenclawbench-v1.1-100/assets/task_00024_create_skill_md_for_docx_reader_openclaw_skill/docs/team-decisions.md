# OpenClaw Architecture Decision Records

This document tracks key architectural decisions made by the OpenClaw platform team.

---

## ADR-019: Python Skill Dependency Management (March 2024)

**Status: Accepted**

**Context:** New Python-based skills need a standardized way to declare and install runtime dependencies so the agent provisioner can set up environments consistently.

**Decision:** All Python skills will use a `requirements.txt` file for dependency declaration. The OpenClaw provisioner reads this file and runs `pip install -r requirements.txt` before skill execution.

**Consequences:** Familiar tooling with broad ecosystem support. No built-in version pinning verification or supply-chain integrity checks.

---

## ADR-031: Pilot v2 Skill Specification for docx-reader (October 2024)

**Status: Accepted and Merged (PR #892, approved by @platform-team)**

**Context:** The OpenClaw v2 skill specification (`docs/openclaw-skill-spec-v2-draft.md`) has completed internal review. The platform team has approved a controlled pilot to validate the new format before broad rollout. The `docx-reader` skill was selected as the pilot due to its clean-slate status and limited scope.

**Decision:** The `docx-reader` SKILL.md MUST follow the v2 specification. Specifically:

1. Dependency declarations MUST use a `deps.yaml` file. A starter `config/deps.yaml` already exists and should be adapted for the skill directory.
2. The SKILL.md MUST include a `permissions` section declaring the permissions the skill requires. For docx-reader, the minimum required permissions are:
   - `filesystem:read` (for reading input `.docx` files)
   - `filesystem:write` (for writing output `.txt` files)
3. The legacy `requirements.txt` approach is deprecated for this skill; it will remain in the directory for backward compatibility only.

**Consequences:** The docx-reader SKILL.md will differ from existing v1 skills (e.g., csv-reader). A successful pilot will trigger migration of all new skills to v2 format starting Q1 2025.

---

## ADR-032: Runtime Declaration Standardization (December 2024)

**Status: Proposed — Under Review**

**Context:** Several SKILL.md files use inconsistent runtime labels (`python3`, `python 3`, `Python 3.x`). Standardization would improve agent config parsing reliability.

**Decision:** TBD — awaiting platform team vote.
