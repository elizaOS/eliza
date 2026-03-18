---
name: security-burpsuite-project-parser
description: "Parse and analyze Burp Suite project files, HTTP history, and scan results. Use when extracting findings from Burp Suite exports, analyzing intercepted HTTP traffic, processing Burp XML exports, or correlating Burp scan results with source code."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Burp Suite Project Parser

## When to Use

- Parsing Burp Suite XML export files for findings
- Analyzing HTTP request/response history from Burp
- Extracting and deduplicating vulnerability findings
- Correlating Burp scan results with source code locations
- Converting Burp output to other formats (CSV, JSON, SARIF)

## When NOT to Use

- Running active Burp scans (use Burp Suite directly)
- Configuring Burp extensions
- General web application testing without Burp data

## Burp XML Export Format

Burp Suite exports data in XML format with these key elements:

```xml
<items>
  <item>
    <time>...</time>
    <url>https://example.com/api/user</url>
    <host ip="1.2.3.4">example.com</host>
    <port>443</port>
    <protocol>https</protocol>
    <method>POST</method>
    <path>/api/user</path>
    <request base64="true">...</request>
    <response base64="true">...</response>
    <status>200</status>
    <responselength>1234</responselength>
    <mimetype>JSON</mimetype>
  </item>
</items>
```

## Parsing Commands

```bash
# Extract all unique URLs from Burp export
xmllint --xpath '//item/url/text()' burp_export.xml 2>/dev/null | sort -u

# Extract URLs with response status
python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('burp_export.xml')
for item in tree.findall('.//item'):
    url = item.findtext('url', '')
    status = item.findtext('status', '')
    method = item.findtext('method', '')
    print(f'{method} {status} {url}')
"

# Decode base64 request/response bodies
python3 -c "
import xml.etree.ElementTree as ET, base64
tree = ET.parse('burp_export.xml')
for item in tree.findall('.//item'):
    req = item.find('request')
    if req is not None and req.get('base64') == 'true':
        print(base64.b64decode(req.text).decode('utf-8', errors='replace'))
        print('---')
"
```

## Analysis Workflow

1. **Export** Burp project data as XML (HTTP history or scan results)
2. **Parse** XML to extract requests, responses, and findings
3. **Deduplicate** findings by URL pattern and vulnerability type
4. **Correlate** with source code (map endpoints to handlers)
5. **Prioritize** by severity, exploitability, and business impact
6. **Report** findings with request/response evidence

## Common Findings to Extract

| Finding Type | Indicator in Burp Data |
|-------------|----------------------|
| SQL Injection | Error-based responses, time delays |
| XSS | Reflected input in response body |
| Auth bypass | 200 status on restricted endpoints without auth |
| Information disclosure | Stack traces, debug info in responses |
| CSRF | Missing tokens on state-changing requests |
| Open redirect | 3xx with user-controlled Location header |
