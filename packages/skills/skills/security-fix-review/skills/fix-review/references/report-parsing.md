# Report Parsing Strategies

Parsing security audit reports in various formats.

## Overview

Security reports come in multiple formats. This guide covers parsing strategies for each format and handling special cases like Google Drive URLs.

---

## Trail of Bits Format

Trail of Bits reports follow a consistent structure.

### Structure

```
1. Executive Summary
2. Project Dashboard
3. Engagement Goals
4. Coverage
5. Automated Testing
6. Findings Overview
7. Detailed Findings
   - Each finding starts on new page
   - Header table with ID, title, severity, type, target
   - Description, Exploit Scenario, Recommendations
8. Appendices
```

### Finding Identification

Each finding has a header table:

| Field | Format |
|-------|--------|
| ID | `TOB-[CLIENT]-[NUMBER]` (e.g., TOB-ACME-1) |
| Title | Descriptive title |
| Severity | Informational, Low, Medium, High |
| Difficulty | Low, Medium, High, Undetermined |
| Type | Access Controls, Cryptography, Data Validation, etc. |
| Target | File path(s) |

### Extraction Pattern

```
1. Locate "Detailed Findings" section
2. For each finding, extract:
   - ID: Match pattern /TOB-[A-Z]+-[0-9]+/
   - Title: Text following ID in header
   - Severity: From header table
   - Target: File paths from header table
   - Description: Content after "Description" heading
   - Recommendations: Content after "Recommendations" heading
```

### Example Finding

```markdown
## TOB-ACME-1: Missing access control in withdraw function

| Field | Value |
|-------|-------|
| ID | TOB-ACME-1 |
| Severity | High |
| Difficulty | Low |
| Type | Access Controls |
| Target | contracts/Vault.sol |

### Description

The `withdraw` function in `Vault.sol` lacks access control...

### Recommendations

Short term, add the `onlyOwner` modifier...
```

---

## Generic Report Formats

### Numbered Findings

Reports with numbered findings (Finding 1, Finding 2, etc.):

```
Pattern: /Finding\s+[0-9]+:?\s+(.+)/
         /[0-9]+\.\s+(.+)/
         /#[0-9]+\s+(.+)/
```

Extract:
- Number as ID
- Following text as title
- Look for severity keywords nearby

### Severity-Based Sections

Reports organized by severity:

```
## Critical
### Finding title
...

## High
### Another finding
...
```

Extract:
- Section heading as severity
- Sub-headings as finding titles
- Generate IDs (CRITICAL-1, HIGH-1, etc.)

### Table-Based Findings

Reports with findings in tables:

```markdown
| ID | Title | Severity | Status |
|----|-------|----------|--------|
| V-01 | SQL Injection | High | Open |
| V-02 | XSS in search | Medium | Open |
```

Extract by parsing table structure.

### JSON Format

Reports in JSON structure:

```json
{
  "findings": [
    {
      "id": "VULN-001",
      "title": "SQL Injection",
      "severity": "high",
      "description": "...",
      "files": ["app/db.py"]
    }
  ]
}
```

Parse directly from JSON structure.

---

## Format Detection

When report format is unknown:

### Step 1: Check for TOB Format

```
Search for: "TOB-" followed by letters and numbers
If found: Use TOB parsing
```

### Step 2: Check for JSON

```
If file extension is .json or content starts with '{':
  Parse as JSON
  Look for "findings" array
```

### Step 3: Check for Markdown Structure

```
Search for: "## Finding" or "### Finding"
Search for: Severity headings (Critical, High, Medium, Low)
Search for: Numbered patterns (1., 2., or Finding 1, Finding 2)
```

### Step 4: Fall Back to Keyword Extraction

```
Search for severity keywords: critical, high, medium, low, informational
Search for vulnerability keywords: vulnerability, issue, bug, flaw
Extract surrounding context as findings
```

---

## Google Drive Handling

When a Google Drive URL is provided and WebFetch fails (permissions, redirect):

### Step 1: Detect Google Drive URL

```
Pattern: https://drive.google.com/file/d/[FILE_ID]/...
         https://docs.google.com/document/d/[DOC_ID]/...
         https://drive.google.com/open?id=[FILE_ID]
```

### Step 2: Extract File ID

```bash
# From /file/d/ URLs
FILE_ID=$(echo "$URL" | grep -oP 'file/d/\K[^/]+')

# From /document/d/ URLs
FILE_ID=$(echo "$URL" | grep -oP 'document/d/\K[^/]+')

# From ?id= URLs
FILE_ID=$(echo "$URL" | grep -oP 'id=\K[^&]+')
```

### Step 3: Check for gdrive CLI

```bash
# Check if gdrive is installed
if command -v gdrive &> /dev/null; then
    # Check if gdrive is configured (has auth)
    if gdrive about &> /dev/null; then
        echo "gdrive available and configured"
    else
        echo "gdrive installed but not configured"
    fi
else
    echo "gdrive not installed"
fi
```

### Step 4: Download with gdrive

If gdrive is available and configured:

```bash
# Download to temp directory
gdrive files download "$FILE_ID" --path /tmp/

# Find the downloaded file
DOWNLOADED=$(ls -t /tmp/ | head -1)

# Read the file
cat "/tmp/$DOWNLOADED"
```

### Step 5: User Instructions (if gdrive unavailable)

If gdrive is not available or not configured:

```
Unable to access the Google Drive URL directly. Please:

1. Open the URL in your browser
2. Download the file:
   - For Google Docs: File → Download → Markdown (.md)
   - For PDFs: Click download button
3. Provide the local file path

Alternatively, install and configure gdrive:
   brew install gdrive
   gdrive about  # Follow auth prompts
```

---

## File Format Handling

### PDF Files

Claude can read PDFs directly using the Read tool:

```
Read /path/to/report.pdf
```

For large PDFs, process section by section:
1. Read table of contents/overview
2. Locate "Findings" section
3. Read findings section in detail

### Markdown Files

Read directly:

```
Read /path/to/report.md
```

### HTML Files

Read and parse:

```
Read /path/to/report.html
```

Extract text content, ignoring HTML tags.

### JSON Files

Read and parse as structured data:

```
Read /path/to/report.json
```

Access fields directly from JSON structure.

---

## Extraction Output Format

Regardless of input format, normalize findings to:

```json
{
  "findings": [
    {
      "id": "TOB-ACME-1",
      "title": "Missing access control in withdraw",
      "severity": "High",
      "difficulty": "Low",
      "type": "Access Controls",
      "files": ["contracts/Vault.sol"],
      "description": "The withdraw function lacks...",
      "recommendation": "Add onlyOwner modifier..."
    }
  ],
  "metadata": {
    "client": "ACME",
    "date": "2024-01-15",
    "format": "tob"
  }
}
```

This normalized format enables consistent processing regardless of source format.

---

## Handling Incomplete Reports

When report lacks standard structure:

### Missing Finding IDs

Generate IDs based on:
- Severity + sequence: `HIGH-1`, `HIGH-2`, `MEDIUM-1`
- Position: `FINDING-1`, `FINDING-2`
- File path: `VAULT-1`, `TOKEN-1`

### Missing Severity

Infer from:
- Keywords: "critical", "severe", "important" → High
- Impact description: "attacker can steal" → High
- Default to "Undetermined" if unclear

### Missing File References

Search report for:
- File paths: `/path/to/file`, `src/module/file.py`
- Function names: `function()`, `method()`
- Contract names: `Contract.function`

---

## Error Handling

### File Not Found

```
Unable to read report at [path].
Please verify the file exists and provide the correct path.
```

### Unsupported Format

```
Unable to parse report format.
Supported formats: PDF, Markdown, JSON, HTML
Please convert to a supported format or provide as Markdown.
```

### Empty Findings

```
No findings detected in the report.
Please verify this is a security audit report with findings.
If findings exist but weren't detected, provide them manually.
```

### Partial Parse

```
Parsed [N] findings, but some content may have been missed.
Detected findings: [list IDs]
Please verify all expected findings are included.
```
