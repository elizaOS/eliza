#!/usr/bin/env python3
"""
Traverse the awesome-prompt-injection index, inspect linked local GitHub repos,
and summarize which ones contain reusable prompt-injection assets.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path(__file__).resolve().parents[5]
AWESOME_README = WORKSPACE_ROOT / "external-sources" / "awesome-prompt-injection" / "README.md"
LINKED_ROOT = WORKSPACE_ROOT / "external-sources" / "awesome-linked"
OUTPUT_ROOT = Path(__file__).resolve().parents[4] / "training-data" / "awesome-link-review"

MARKDOWN_LINK_PATTERN = re.compile(r"\[([^\]]+)\]\((https?://[^)]+)\)")
SECTION_PATTERN = re.compile(r"^##\s+(.+?)\s*$", re.M)
GITHUB_REPO_PATTERN = re.compile(r"^https://github\.com/([^/]+)/([^/#?]+)")
PAPER_PATTERN = re.compile(r"(arxiv\.org|doi\.org|acm\.org|openreview\.net|paperswithcode\.com)")
VIDEO_PATTERN = re.compile(r"(youtube\.com|youtu\.be)")


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def parse_markdown_links(text: str) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    current_section = "Introduction"
    for line in text.splitlines():
        header_match = re.match(r"^##\s+(.+?)\s*$", line)
        if header_match:
            current_section = header_match.group(1).strip()
        for label, url in MARKDOWN_LINK_PATTERN.findall(line):
            links.append(
                {
                    "label": normalize_text(label),
                    "url": url.strip(),
                    "section": current_section,
                }
            )
    return links


def classify_url(url: str) -> str:
    if GITHUB_REPO_PATTERN.search(url):
        return "github"
    if PAPER_PATTERN.search(url):
        return "paper"
    if VIDEO_PATTERN.search(url):
        return "video"
    return "other"


def repo_name_from_url(url: str) -> str | None:
    match = GITHUB_REPO_PATTERN.search(url)
    if not match:
        return None
    repo = match.group(2)
    if repo.endswith(".git"):
        repo = repo[:-4]
    return repo


def count_pattern(path: Path, pattern: str) -> int:
    if not path.exists():
        return 0
    return len(re.findall(pattern, path.read_text(encoding="utf-8", errors="ignore"), re.M))


def inspect_local_repo(repo_name: str, repo_path: Path) -> dict[str, Any]:
    info: dict[str, Any] = {
        "localPath": str(repo_path),
        "present": repo_path.exists(),
        "assetCounts": {},
        "recommendedUse": "reference-only",
        "notes": "",
    }
    if not repo_path.exists():
        info["notes"] = "Repo not cloned locally."
        return info

    if repo_name == "injectlab":
        yaml_count = len(list((repo_path / "injectlab-suite").glob("*.yaml")))
        info["assetCounts"] = {
            "yamlTests": yaml_count,
            "mitigationDocs": 2,
        }
        info["recommendedUse"] = "direct-scenario-materialization"
        info["notes"] = (
            "Structured YAML prompt-injection tests with prompts, expected behavior, and mitigations."
        )
    elif repo_name == "token-turbulenz":
        info["assetCounts"] = {
            "attackTemplates": len(list((repo_path / "templates").glob("*.yaml"))),
            "tokenVocabularySize": count_pattern(repo_path / "tokens.list", r"(?m)^"),
        }
        info["recommendedUse"] = "direct-template-materialization"
        info["notes"] = (
            "Contains token-turbulence attack templates that splice malicious payloads into benign prompts."
        )
    elif repo_name == "BodAIGuard":
        info["assetCounts"] = {
            "guardrailRules": count_pattern(
                repo_path / "rules" / "default.yaml", r"(?m)^\s*-\s+pattern:"
            ),
            "exampleScanCommands": count_pattern(repo_path / "README.md", r"(?m)^bodaiguard scan "),
        }
        info["recommendedUse"] = "pattern-taxonomy-and-variant-generation"
        info["notes"] = (
            "Large guardrail rule corpus with prompt-injection, exfiltration, and delimiter examples."
        )
    elif repo_name == "openclaw-bastion":
        info["assetCounts"] = {
            "patternRules": count_pattern(repo_path / "scripts" / "bastion.py", r'^\s*\(r"'),
            "documentedPatternFamilies": count_pattern(repo_path / "README.md", r"^- \*\*"),
        }
        info["recommendedUse"] = "pattern-taxonomy-and-variant-generation"
        info["notes"] = (
            "Deterministic scanner patterns for instruction override, hidden content, exfiltration, Unicode, and tool abuse."
        )
    elif repo_name == "damn-vulnerable-llm-agent":
        info["assetCounts"] = {
            "examplePayloadBlocks": count_pattern(repo_path / "README.md", r"(?m)^````?$"),
            "challengeFlags": count_pattern(repo_path / "README.md", r"\bflag\b"),
        }
        info["recommendedUse"] = "react-loop-hijack-scenarios"
        info["notes"] = (
            "Contains concrete ReAct observation/thought injection and SQL/tool-abuse payloads."
        )
    elif repo_name == "ctf-prompt-injection":
        levels_path = repo_path / "levels.json"
        levels = json.loads(levels_path.read_text(encoding="utf-8")) if levels_path.exists() else []
        info["assetCounts"] = {
            "levels": len(levels),
            "embeddedSecrets": len(levels),
        }
        info["recommendedUse"] = "ctf-secret-exfiltration-scenarios"
        info["notes"] = (
            "Simple challenge levels with explicit protected secrets and disclosure constraints."
        )
    elif repo_name == "ai-prompt-ctf":
        level_files = list((repo_path / "ctf" / "agents" / "sub_agents").glob("level_*_agent.py"))
        info["assetCounts"] = {
            "levelAgents": len(level_files),
            "evalSets": len(list((repo_path / "ctf" / "agents" / "eval").glob("*.json"))),
        }
        info["recommendedUse"] = "multi-family-ctf-scenario-generation"
        info["notes"] = (
            "Multi-level challenge repo spanning prompt injection, output filtering, tool abuse, web injection, and reasoning attacks."
        )
    elif repo_name == "garak":
        probes_dir = repo_path / "garak" / "probes"
        info["assetCounts"] = {
            "probeModules": len(list(probes_dir.glob("*.py"))) if probes_dir.exists() else 0,
            "documentedProbeFamilies": count_pattern(
                repo_path / "README.md", r"^\|\s+[a-zA-Z0-9_]+"
            ),
        }
        info["recommendedUse"] = "probe-taxonomy-and-adversarial-family-reference"
        info["notes"] = (
            "Large LLM vulnerability scanner with broad probe families; best used as taxonomy and future probe source."
        )
    elif repo_name == "prompt-injection-defenses":
        info["assetCounts"] = {
            "linkedDefenses": count_pattern(repo_path / "README.md", r"^\| \["),
        }
        info["recommendedUse"] = "defense-and-ablation-reference"
        info["notes"] = (
            "Defense survey, useful for mitigation baselines and ablation framing rather than direct attack data."
        )
    elif repo_name == "sentinel-ai":
        blog_path = repo_path / "site" / "blog" / "claude-md-attacks.html"
        sdk_path = repo_path / "sdk-js" / "README.md"
        info["assetCounts"] = {
            "blogAttackCategories": count_pattern(blog_path, r'<div class="attack-box">'),
            "scannerFamilies": count_pattern(sdk_path, r"^\| \*\*"),
        }
        info["recommendedUse"] = "attack-pattern-materialization-and-detection-variants"
        info["notes"] = (
            "Contains concrete injection examples for instruction files plus scanner-family docs."
        )
    elif repo_name == "pic-standard":
        info["assetCounts"] = {
            "policyExamples": len(list((repo_path / "examples").glob("*.json"))),
            "policySpecs": len(list(repo_path.glob("pic_*.json"))),
        }
        info["recommendedUse"] = "policy-and-approval-reference"
        info["notes"] = (
            "Policy spec and action-risk examples, useful for tool-call governance rather than prompt corpora."
        )
    elif repo_name == "agentseal":
        injection_path = repo_path / "js" / "src" / "probes" / "injection.ts"
        probes_doc = repo_path / "PROBES.md"
        info["assetCounts"] = {
            "injectionProbes": count_pattern(injection_path, r'probe_id:\s*"'),
            "multiTurnProbes": count_pattern(injection_path, r"is_multi_turn:\s*true"),
            "documentedProbeFamilies": count_pattern(probes_doc, r"^\| \d+ \|"),
        }
        info["recommendedUse"] = "high-value-probe-materialization"
        info["notes"] = (
            "Large concrete probe library with multi-turn, tool, memory-poisoning, and chain-of-thought attacks."
        )
    elif repo_name == "vigil-llm":
        info["assetCounts"] = {
            "datasetDocs": count_pattern(repo_path / "docs" / "datasets.md", r"(?m)^\* "),
            "yaraRuleFiles": len(list((repo_path / "data" / "yara").glob("*.yar*")))
            if (repo_path / "data" / "yara").exists()
            else 0,
        }
        info["recommendedUse"] = "dataset-and-detector-reference"
        info["notes"] = (
            "Prompt-injection detector stack with references to prompt/jailbreak datasets and YARA rules."
        )
    elif repo_name == "injecguard":
        info["assetCounts"] = {
            "localDatasets": len(list((repo_path / "datasets").glob("*.json"))),
            "evaluationBenchmarksMentioned": count_pattern(
                repo_path / "README.md", r"\b(NotInject|PINT|BIPIA|Wildguard)\b"
            ),
        }
        info["recommendedUse"] = "detector-dataset-reference"
        info["notes"] = (
            "Ships local prompt-injection detector datasets and over-defense evaluation references."
        )
    else:
        info["assetCounts"] = {
            "markdownFiles": len(list(repo_path.rglob("*.md"))),
            "yamlFiles": len(list(repo_path.rglob("*.yaml"))) + len(list(repo_path.rglob("*.yml"))),
            "jsonFiles": len(list(repo_path.rglob("*.json"))),
        }
        info["notes"] = "General linked repo; inspect manually if needed."

    return info


def repo_inventory(links: list[dict[str, str]]) -> list[dict[str, Any]]:
    repos: list[dict[str, Any]] = []
    seen: set[str] = set()
    for link in links:
        if classify_url(link["url"]) != "github":
            continue
        repo_name = repo_name_from_url(link["url"])
        if not repo_name or repo_name == "awesome-prompt-injection":
            continue
        if repo_name in seen:
            continue
        seen.add(repo_name)
        local_path = LINKED_ROOT / repo_name
        repo_info = inspect_local_repo(repo_name, local_path)
        repos.append(
            {
                "repo": repo_name,
                "url": link["url"],
                "label": link["label"],
                "section": link["section"],
                **repo_info,
            }
        )
    return repos


def write_markdown(path: Path, summary: dict[str, Any], repos: list[dict[str, Any]]) -> None:
    lines = [
        "# Awesome Prompt Injection Link Review",
        "",
        f"- Generated: `{summary['generatedAt']}`",
        f"- Total outbound links: `{summary['totalLinks']}`",
        f"- GitHub repos: `{summary['githubLinks']}`",
        f"- Papers: `{summary['paperLinks']}`",
        f"- Videos: `{summary['videoLinks']}`",
        "",
        "## Sections",
        "",
    ]
    for section, count in summary["sectionCounts"].items():
        lines.append(f"- `{section}`: `{count}`")
    lines.extend(["", "## GitHub Repos", ""])
    for repo in repos:
        lines.append(f"### `{repo['repo']}`")
        lines.append(f"- URL: `{repo['url']}`")
        lines.append(f"- Section: `{repo['section']}`")
        lines.append(f"- Recommended use: `{repo['recommendedUse']}`")
        if repo["assetCounts"]:
            counts = ", ".join(
                f"{key}={value}" for key, value in sorted(repo["assetCounts"].items())
            )
            lines.append(f"- Asset counts: `{counts}`")
        lines.append(f"- Notes: {repo['notes']}")
        lines.append("")
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Review outbound links from awesome-prompt-injection."
    )
    parser.add_argument(
        "--awesome-readme",
        default=str(AWESOME_README),
        help="Path to the local awesome-prompt-injection README.md",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory to write the review artifacts into.",
    )
    args = parser.parse_args()

    awesome_readme = Path(args.awesome_readme).resolve()
    text = awesome_readme.read_text(encoding="utf-8")
    links = parse_markdown_links(text)
    repos = repo_inventory(links)

    generated_at = datetime.now(timezone.utc).isoformat()
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    output_dir = Path(args.output_dir).resolve() if args.output_dir else OUTPUT_ROOT / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "generatedAt": generated_at,
        "awesomeReadme": str(awesome_readme),
        "totalLinks": len(links),
        "githubLinks": sum(1 for link in links if classify_url(link["url"]) == "github"),
        "paperLinks": sum(1 for link in links if classify_url(link["url"]) == "paper"),
        "videoLinks": sum(1 for link in links if classify_url(link["url"]) == "video"),
        "otherLinks": sum(1 for link in links if classify_url(link["url"]) == "other"),
        "sectionCounts": dict(Counter(link["section"] for link in links)),
        "repoRecommendationCounts": dict(Counter(repo["recommendedUse"] for repo in repos)),
    }

    (output_dir / "inventory.json").write_text(
        json.dumps(
            {
                "summary": summary,
                "links": links,
                "repos": repos,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    write_markdown(output_dir / "inventory.md", summary, repos)

    print(
        json.dumps(
            {
                "output_dir": str(output_dir),
                "github_repos_reviewed": len(repos),
                "github_links": summary["githubLinks"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
