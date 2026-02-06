# Differential Testing Plugin

Verify that code changes address security audit findings without introducing bugs.

## Overview

This plugin provides tools for reviewing fix branches against security audit reports. It analyzes commit ranges to:

1. **Verify finding remediation** - Check that each audit finding has been properly addressed
2. **Detect bug introduction** - Identify potential bugs or security regressions in the fix commits
3. **Generate verification reports** - Create detailed reports documenting finding status and concerns

## Components

### Skill: fix-review

Domain knowledge for differential analysis and finding verification.

**Triggers on:**
- "verify these commits fix the audit findings"
- "check if TOB-XXX was addressed"
- "review the fix branch"
- "validate remediation commits"

### Command: /fix-review

Explicit invocation for fix verification.

```bash
/fix-review <source-commit> <target-commit(s)> [--report <path-or-url>]
```

**Examples:**
```bash
# Basic usage: compare two commits
/fix-review abc123 def456

# With audit report
/fix-review main fix-branch --report ./audit-report.pdf

# Multiple target commits
/fix-review v1.0.0 commit1 commit2 --report https://example.com/report.md

# Google Drive report
/fix-review baseline fixes --report https://drive.google.com/file/d/XXX/view
```

## Features

### Report Format Support

- **PDF** - Read directly (Claude native support)
- **Markdown** - Read directly
- **JSON** - Parsed as structured data
- **HTML** - Text extraction

### Finding Format Support

- **Trail of Bits** - `TOB-CLIENT-N` format with header tables
- **Generic** - Numbered findings, severity sections
- **JSON** - Structured `findings` array

### Google Drive Integration

If a Google Drive URL is provided and direct access fails:

1. Checks for `gdrive` CLI tool
2. If available, downloads the file automatically
3. If not, provides instructions for manual download

## Output

Generates `FIX_REVIEW_REPORT.md` containing:

- Executive summary
- Finding status table (FIXED, PARTIALLY_FIXED, NOT_ADDRESSED, CANNOT_DETERMINE)
- Bug introduction concerns
- Per-commit analysis
- Recommendations

Also provides a conversation summary with key findings.

## Bug Detection

Analyzes commits for security anti-patterns:

| Pattern | Risk |
|---------|------|
| Validation removed | Input bypass |
| Access control weakened | Privilege escalation |
| Error handling reduced | Silent failures |
| External call reordering | Reentrancy |
| Integer operations changed | Overflow/underflow |

## Integration

Works alongside other Trail of Bits skills:

- **differential-review** - For initial security review of changes
- **issue-writer** - To format findings into formal reports
- **audit-context-building** - For deep context on complex fixes

## Installation

This plugin is part of the Trail of Bits skills marketplace. Enable it in Claude Code settings.

## Prerequisites

- Git repository with commit history
- Optional: `gdrive` CLI for Google Drive integration
  ```bash
  brew install gdrive  # macOS
  gdrive about         # Configure authentication
  ```

## License

CC-BY-SA-4.0
