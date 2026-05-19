/**
 * Markdown scaffold for new skill SKILL.md files.
 * Re-exports the contents of skill-scaffold.md as a TS string so it survives
 * the tsc-only build (no asset copy step).
 *
 * Placeholders __SLUG__ and __DESCRIPTION__ are replaced at scaffold time.
 */
export const skillScaffoldMarkdown = `---
name: __SLUG__
description: __DESCRIPTION__
---

## Instructions

[Describe what this skill does and how the agent should use it]

## When to Use

Use this skill when [describe trigger conditions].

## Steps

1. [First step]
2. [Second step]
3. [Third step]
`;
