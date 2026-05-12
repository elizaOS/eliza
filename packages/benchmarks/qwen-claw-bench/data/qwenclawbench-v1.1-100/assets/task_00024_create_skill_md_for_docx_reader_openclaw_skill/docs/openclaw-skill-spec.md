# OpenClaw Skill Specification

This document defines the official structure and required sections for a skill's `SKILL.md` file in the OpenClaw agent framework (v1).

## Overview

Every skill registered with an OpenClaw agent must include a `SKILL.md` file at the root of the skill directory. This file serves as both documentation and machine-readable metadata for the agent runtime.

## Required SKILL.md Sections

The following sections **must** be present in every `SKILL.md`:

### name
The unique identifier for the skill. Should match the skill's directory name (e.g., `csv-reader`).

### description
A brief summary of what the skill does. One to three sentences recommended.

### version
Semantic version string (e.g., `1.0.0`). Used by the agent to track skill updates.

### author
The individual or team responsible for maintaining the skill.

### runtime
The runtime environment required to execute the skill (e.g., `python3`, `node18`). Skills must declare their runtime so the agent can provision the correct execution environment.

### dependencies
A list of external packages or libraries the skill depends on. Dependencies should also be listed in a `requirements.txt` file (for Python skills) or equivalent manifest for other runtimes.

### usage
A command-line example showing how to invoke the skill's main script (e.g., `python convert_csv.py input.csv`).

### inputs
A description of the expected input(s) — file types, argument formats, or data schemas.

### outputs
A description of what the skill produces — output file types, stdout format, or side effects.

## Additional Notes

- Skills are registered in the agent's `openclaw.yaml` configuration file under `registered_skills`.
- The `requirements.txt` file is the canonical source for Python dependency declarations. The agent's provisioning system reads this file to install packages before execution.
- All skill directories must be placed under the path specified by `skills_dir` in the agent config.
