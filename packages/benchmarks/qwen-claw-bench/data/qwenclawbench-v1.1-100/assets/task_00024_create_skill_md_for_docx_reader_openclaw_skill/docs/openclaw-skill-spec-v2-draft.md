# OpenClaw Skill Specification v2 (DRAFT)

> **Status: DRAFT** — This document is under review and may change before final release.

This document describes the updated skill specification for OpenClaw v2. It supersedes the v1 specification with several important changes to improve security and dependency management.

## Required SKILL.md Sections

All skills must include the following sections in their `SKILL.md`:

### name
The unique skill identifier. Must match the directory name.

### description
A short summary of the skill's purpose and functionality.

### version
Semantic version string (e.g., `1.0.0`).

### author
The maintainer or team responsible for the skill.

### runtime
The execution runtime (e.g., `python3`, `node18`).

### permissions
**New in v2.** A list of permissions the skill requires to operate. This section is mandatory. Examples include `filesystem:read`, `filesystem:write`, `network:outbound`, `env:read`. The agent will deny execution if required permissions are not declared.

### dependencies
A summary of external packages. **In v2, all dependencies must be formally declared in a `deps.yaml` file** located in the skill's root directory. The `deps.yaml` format supports pinned versions, source repositories, and integrity checksums. The legacy `requirements.txt` approach is deprecated and will not be read by the v2 agent runtime.

### usage
Command-line invocation example.

### inputs
Description of expected inputs.

### outputs
Description of produced outputs.

## Migration from v1

- Add a `permissions` section to every `SKILL.md`.
- Replace `requirements.txt` with `deps.yaml`. The v2 provisioner reads only `deps.yaml`.
- Update your agent config to set `spec_version: 2`.

## deps.yaml Format

```yaml
skill: my-skill
dependencies:
  - name: some-package
    version: "1.2.3"
    source: pypi
    sha256: abc123...
```

The `deps.yaml` file provides stronger guarantees around reproducibility and supply-chain security compared to plain `requirements.txt`.
