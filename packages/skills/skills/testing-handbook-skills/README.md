# Testing Handbook Skills

Meta-skill that generates Claude Code skills from the [Trail of Bits Application Security Testing Handbook](https://appsec.guide).

## Overview

This plugin provides a skill generator that:

1. Analyzes the Testing Handbook structure
2. Identifies skill candidates (tools, techniques, domains)
3. Generates skills using appropriate templates
4. Validates generated skills

## Installation

Add to your Claude Code skills configuration:

```bash
# From the skills marketplace
claude skills install testing-handbook-skills

# Or manually add to .claude/settings.json
{
  "plugins": [
    "./plugins/testing-handbook-skills"
  ]
}
```

## Usage

### Generate All Skills

```
Generate skills from the testing handbook
```

This will:
1. Locate the handbook (check common locations, ask user, or clone)
2. Scan the handbook structure
3. Present a plan of skills to generate
4. On approval, generate skills as siblings to `testing-handbook-generator/`

### Generate Specific Skill

```
Create a skill for the libFuzzer section of the testing handbook
```

## Structure

```
plugins/testing-handbook-skills/
├── .claude-plugin/
│   └── plugin.json
├── scripts/
│   └── validate-skills.py        # Skill validation tool
├── skills/
│   ├── testing-handbook-generator/
│   │   ├── SKILL.md              # Main skill entry point
│   │   ├── discovery.md          # Handbook analysis methodology
│   │   ├── testing.md            # Validation strategy
│   │   ├── agent-prompt.md       # Agent prompt template for generation
│   │   └── templates/            # Skill generation templates
│   │       ├── tool-skill.md     # Semgrep, CodeQL
│   │       ├── fuzzer-skill.md   # libFuzzer, AFL++, cargo-fuzz
│   │       ├── technique-skill.md # Harness writing, coverage
│   │       └── domain-skill.md   # Crypto testing, web security
│   ├── [generated-skill]/        # Generated skills (siblings to generator)
│   │   └── SKILL.md
│   └── ...
└── README.md
```

### Scripts

| Script | Purpose |
|--------|---------|
| `validate-skills.py` | Validates generated skills (YAML, sections, line count, shortcodes, cross-refs) |

```bash
# Validate all skills
uv run scripts/validate-skills.py

# Validate specific skill
uv run scripts/validate-skills.py --skill libfuzzer

# JSON output for CI
uv run scripts/validate-skills.py --json
```

## Skill Types

| Type | Template | Example Sources |
|------|----------|-----------------|
| Tool | tool-skill.md | Semgrep, CodeQL |
| Fuzzer | fuzzer-skill.md | libFuzzer, AFL++, cargo-fuzz |
| Technique | technique-skill.md | Harness writing, coverage analysis |
| Domain | domain-skill.md | Wycheproof, constant-time testing |

## Generated Skills

Generated skills are written as siblings to the generator:
```
skills/[skill-name]/SKILL.md
```

Each generated skill:
- Follows the appropriate template structure
- Contains content extracted from the handbook
- Includes resource links (WebFetch summaries for non-videos)
- Is validated with `scripts/validate-skills.py` before delivery

## Skills Cross-Reference

This graph shows the 16 generated skills and their cross-references (from the Related Skills section of each skill). Only links between actually generated skills are shown.

```mermaid
graph TB
    subgraph Fuzzers
        libfuzzer[libfuzzer]
        aflpp[aflpp]
        libafl[libafl]
        cargo-fuzz[cargo-fuzz]
        atheris[atheris]
        ruzzy[ruzzy]
    end

    subgraph Techniques
        harness-writing[harness-writing]
        address-sanitizer[address-sanitizer]
        coverage-analysis[coverage-analysis]
        fuzzing-dictionary[fuzzing-dictionary]
        fuzzing-obstacles[fuzzing-obstacles]
        ossfuzz[ossfuzz]
    end

    subgraph Tools
        semgrep[semgrep]
        codeql[codeql]
    end

    subgraph Domain
        wycheproof[wycheproof]
        constant-time-testing[constant-time-testing]
    end

    %% Fuzzer → Technique references
    libfuzzer --> address-sanitizer
    libfuzzer --> coverage-analysis
    aflpp --> address-sanitizer
    cargo-fuzz --> address-sanitizer
    cargo-fuzz --> coverage-analysis
    libafl --> address-sanitizer
    libafl --> coverage-analysis
    atheris --> address-sanitizer
    atheris --> coverage-analysis
    ruzzy --> address-sanitizer

    %% Fuzzer ↔ Fuzzer alternatives
    libfuzzer -.-> aflpp
    libfuzzer -.-> libafl
    aflpp -.-> libfuzzer
    aflpp -.-> libafl
    cargo-fuzz -.-> libfuzzer
    cargo-fuzz -.-> aflpp
    cargo-fuzz -.-> libafl
    libafl -.-> libfuzzer
    libafl -.-> aflpp
    libafl -.-> cargo-fuzz
    ruzzy -.-> libfuzzer
    ruzzy -.-> aflpp

    %% Tool ↔ Tool alternatives
    semgrep -.-> codeql
    codeql -.-> semgrep

    %% Technique → Fuzzer references
    harness-writing --> libfuzzer
    harness-writing --> aflpp
    harness-writing --> cargo-fuzz
    harness-writing --> atheris
    harness-writing --> ossfuzz
    fuzzing-dictionary --> libfuzzer
    fuzzing-dictionary --> aflpp
    fuzzing-dictionary --> cargo-fuzz
    fuzzing-obstacles --> libfuzzer
    fuzzing-obstacles --> aflpp
    fuzzing-obstacles --> cargo-fuzz
    ossfuzz --> libfuzzer
    ossfuzz --> aflpp
    ossfuzz --> cargo-fuzz
    ossfuzz --> atheris

    %% Technique cross-references
    harness-writing --> address-sanitizer
    harness-writing --> coverage-analysis
    harness-writing --> fuzzing-dictionary
    harness-writing --> fuzzing-obstacles
    fuzzing-dictionary --> coverage-analysis
    fuzzing-dictionary --> harness-writing
    address-sanitizer --> coverage-analysis
    ossfuzz --> address-sanitizer
    ossfuzz --> coverage-analysis

    %% Domain → Technique references
    wycheproof --> coverage-analysis
    constant-time-testing --> coverage-analysis
```

**Legend:**
- Solid arrows (`→`): Primary dependencies (techniques, tools used together)
- Dashed arrows (`-.->`): Alternative suggestions (similar tools/fuzzers)

**Generated Skills Summary:**

| Type | Skills |
|------|--------|
| Fuzzers (6) | libfuzzer, aflpp, libafl, cargo-fuzz, atheris, ruzzy |
| Techniques (6) | harness-writing, address-sanitizer, coverage-analysis, fuzzing-dictionary, fuzzing-obstacles, ossfuzz |
| Tools (2) | semgrep, codeql |
| Domain (2) | wycheproof, constant-time-testing |

**Note:** Some skills reference planned/external skills not yet generated (e.g., `honggfuzz`, `fuzzing-corpus`, `sarif-parsing`). Run `validate-skills.py` to see the full list.

## Configuration

The skill will automatically:
1. Check common locations (`./testing-handbook`, `../testing-handbook`, `~/testing-handbook`)
2. Ask the user for the path if not found
3. Clone from GitHub as last resort: `https://github.com/trailofbits/testing-handbook`

No hardcoded paths are used - the skill adapts to your environment.

## Author

Paweł Płatek

## License

See repository license.
