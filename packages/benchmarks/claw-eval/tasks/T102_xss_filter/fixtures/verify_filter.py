#!/usr/bin/env python3
"""Verify that filter.py correctly sanitizes XSS while preserving clean HTML.

Uses only stdlib: html.parser + re for pattern-based checking.
No Selenium/Chromium needed.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from html.parser import HTMLParser


SAMPLES_DIR = "/workspace/fixtures/samples"
FILTER_SCRIPT = "/workspace/filter.py"

ATTACK_PREFIX = "attack_"
CLEAN_PREFIX = "clean_"


class TagCounter(HTMLParser):
    """Count HTML tags in parsed output."""

    def __init__(self):
        super().__init__()
        self.tags = {}
        self.text_content = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        self.tags[tag] = self.tags.get(tag, 0) + 1

    def handle_data(self, data):
        self.text_content.append(data.strip())


# Build quote char class for regex without Python string quoting conflicts
_Q = chr(34) + chr(39)  # " and '

# Patterns that indicate XSS is still present
XSS_PATTERNS = [
    # Script tags
    re.compile(r"<\s*script", re.IGNORECASE),
    re.compile(r"</\s*script", re.IGNORECASE),
    # Event handlers (on* attributes)
    re.compile(r"\bon\w+\s*=", re.IGNORECASE),
    # javascript: protocol in attributes
    re.compile(
        r"(?:href|src|action|formaction|data|srcdoc)\s*=\s*[" + _Q +
        r"\s]*(?:javascript|j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t)\s*:",
        re.IGNORECASE,
    ),
    # javascript: via HTML entities
    re.compile(
        r"(?:&#106;|&#x6a;)(?:&#97;|&#x61;)(?:&#118;|&#x76;)(?:&#97;|&#x61;)",
        re.IGNORECASE,
    ),
    # data: URLs in dangerous attributes
    re.compile(
        r"(?:href|src|data|action)\s*=\s*[" + _Q + r"\s]*data\s*:",
        re.IGNORECASE,
    ),
    # CSS expressions
    re.compile(r"expression\s*\(", re.IGNORECASE),
    # CSS behavior/binding
    re.compile(r"behavior\s*:", re.IGNORECASE),
    re.compile(r"-moz-binding\s*:", re.IGNORECASE),
    # SVG with script or events
    re.compile(r"<\s*svg[^>]*\bon\w+", re.IGNORECASE),
    # Dangerous tags
    re.compile(r"<\s*(?:embed|object)\s", re.IGNORECASE),
    # iframe with dangerous src
    re.compile(
        r"<\s*iframe[^>]*(?:src\s*=\s*[" + _Q +
        r"]\s*(?:javascript|data):|srcdoc\s*=)",
        re.IGNORECASE,
    ),
    # meta refresh to javascript
    re.compile(r"<\s*meta[^>]*url\s*=\s*javascript", re.IGNORECASE),
    # eval/atob calls in attributes
    re.compile(r"\b(?:eval|atob)\s*\(", re.IGNORECASE),
]


def has_xss(content: str) -> bool:
    """Check if content still contains XSS patterns."""
    for pattern in XSS_PATTERNS:
        if pattern.search(content):
            return True
    return False


def check_clean_preservation(original: str, filtered: str) -> dict:
    """Check that clean HTML structure is preserved after filtering."""
    result = {"preserved": True, "issues": []}

    orig_parser = TagCounter()
    filt_parser = TagCounter()
    try:
        orig_parser.feed(original)
        filt_parser.feed(filtered)
    except Exception:
        result["preserved"] = False
        result["issues"].append("parse_error")
        return result

    important_tags = {
        "h1", "h2", "h3", "p", "ul", "ol", "li", "table",
        "tr", "td", "th", "a", "img", "div", "span",
        "nav", "article", "figure", "figcaption",
        "thead", "tbody", "tfoot", "caption", "dl", "dt", "dd",
        "blockquote", "time", "strong", "em",
    }

    for tag in important_tags:
        orig_count = orig_parser.tags.get(tag, 0)
        filt_count = filt_parser.tags.get(tag, 0)
        if orig_count > 0 and filt_count == 0:
            result["preserved"] = False
            result["issues"].append(f"lost_{tag}")

    orig_text = " ".join(orig_parser.text_content).strip()
    filt_text = " ".join(filt_parser.text_content).strip()
    if len(orig_text) > 0:
        ratio = len(filt_text) / len(orig_text)
        if ratio < 0.7:
            result["preserved"] = False
            result["issues"].append(f"text_loss_{ratio:.0%}")

    return result


def run_filter(filter_script: str, html_file: str) -> tuple:
    """Run the filter script on a file. Returns (success, filtered_content)."""
    try:
        proc = subprocess.run(
            [sys.executable, filter_script, html_file],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            return False, ""
        with open(html_file) as f:
            return True, f.read()
    except Exception:
        return False, ""


def main():
    result = {
        "script_exists": False,
        "script_runs": False,
        "xss_total": 0,
        "xss_blocked": 0,
        "xss_blocking_rate": 0.0,
        "clean_total": 0,
        "clean_preserved": 0,
        "clean_preservation_rate": 0.0,
        "per_file": {},
    }

    if not os.path.isfile(FILTER_SCRIPT):
        print(json.dumps(result))
        return

    result["script_exists"] = True

    if not os.path.isdir(SAMPLES_DIR):
        print(json.dumps(result))
        return

    attack_files = sorted(
        f for f in os.listdir(SAMPLES_DIR)
        if f.startswith(ATTACK_PREFIX) and f.endswith(".html")
    )
    clean_files = sorted(
        f for f in os.listdir(SAMPLES_DIR)
        if f.startswith(CLEAN_PREFIX) and f.endswith(".html")
    )

    result["xss_total"] = len(attack_files)
    result["clean_total"] = len(clean_files)

    # Test with first attack file to check script runs
    if attack_files:
        with tempfile.TemporaryDirectory() as tmpdir:
            test_src = os.path.join(SAMPLES_DIR, attack_files[0])
            test_dst = os.path.join(tmpdir, attack_files[0])
            shutil.copy2(test_src, test_dst)
            ok, _ = run_filter(FILTER_SCRIPT, test_dst)
            result["script_runs"] = ok

    # Process attack files
    xss_blocked = 0
    for fname in attack_files:
        with tempfile.TemporaryDirectory() as tmpdir:
            src = os.path.join(SAMPLES_DIR, fname)
            dst = os.path.join(tmpdir, fname)
            shutil.copy2(src, dst)
            ok, filtered = run_filter(FILTER_SCRIPT, dst)

            file_result = {"blocked": False, "run_ok": ok}
            if ok and filtered:
                if not has_xss(filtered):
                    file_result["blocked"] = True
                    xss_blocked += 1
            result["per_file"][fname] = file_result

    result["xss_blocked"] = xss_blocked
    if result["xss_total"] > 0:
        result["xss_blocking_rate"] = round(xss_blocked / result["xss_total"], 4)

    # Process clean files
    clean_preserved = 0
    for fname in clean_files:
        src = os.path.join(SAMPLES_DIR, fname)
        with open(src) as f:
            original = f.read()

        with tempfile.TemporaryDirectory() as tmpdir:
            dst = os.path.join(tmpdir, fname)
            shutil.copy2(src, dst)
            ok, filtered = run_filter(FILTER_SCRIPT, dst)

            file_result = {"preserved": False, "run_ok": ok}
            if ok and filtered:
                check = check_clean_preservation(original, filtered)
                file_result["preserved"] = check["preserved"]
                if check["issues"]:
                    file_result["issues"] = check["issues"]
                if check["preserved"]:
                    clean_preserved += 1
            result["per_file"][fname] = file_result

    result["clean_preserved"] = clean_preserved
    if result["clean_total"] > 0:
        result["clean_preservation_rate"] = round(
            clean_preserved / result["clean_total"], 4
        )

    print(json.dumps(result))


if __name__ == "__main__":
    main()
