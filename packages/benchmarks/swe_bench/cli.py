#!/usr/bin/env python3
"""CLI for running SWE-bench benchmark via the eliza TS bridge.

The agent loop is a single-shot prompt-the-bridge-for-a-patch flow: each
SWE-bench instance is converted into a prompt (issue text + repo context),
sent through the bench server, and the response is parsed for a unified
diff. The diff is then evaluated by ``SWEBenchEvaluator`` (Docker harness
or basic validator).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import textwrap
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from .dataset import SWEBenchDataset
from .evaluator import SWEBenchEvaluator
from .types import (
    PatchStatus,
    RepoStats,
    SWEBenchConfig,
    SWEBenchInstance,
    SWEBenchReport,
    SWEBenchResult,
    SWEBenchVariant,
)

# Ensure the eliza-adapter package is importable.
_ELIZA_ADAPTER_PKG = Path(__file__).resolve().parents[1] / "eliza-adapter"
if _ELIZA_ADAPTER_PKG.exists() and str(_ELIZA_ADAPTER_PKG) not in sys.path:
    sys.path.insert(0, str(_ELIZA_ADAPTER_PKG))

logger = logging.getLogger(__name__)


_PATCH_FENCE_RE = re.compile(
    r"```(?:diff|patch)?\s*\n(?P<body>.*?)```", re.DOTALL | re.IGNORECASE
)
_DIFF_HEADER_RE = re.compile(r"^\s*diff --git ", re.MULTILINE)
_SOURCE_CONTEXT_CACHE: dict[tuple[str, str, str], str | None] = {}
_CODE_PROVIDER_CAPABILITIES = {
    "code.read",
    "code.write",
    "code.edit",
    "code.search",
    "code.shell",
}
_DEFAULT_PROVIDER_CAPABILITIES: dict[str, set[str]] = {
    "claude-code": _CODE_PROVIDER_CAPABILITIES,
    "codex": _CODE_PROVIDER_CAPABILITIES,
    "direct_shell": _CODE_PROVIDER_CAPABILITIES,
    "eliza-code": _CODE_PROVIDER_CAPABILITIES,
    "swe-agent": _CODE_PROVIDER_CAPABILITIES,
}


def _parse_required_capabilities(raw: str | None) -> list[str]:
    if raw is None:
        return []

    required: list[str] = []
    seen: set[str] = set()
    for capability in str(raw).split(","):
        normalized = capability.strip()
        if normalized and normalized not in seen:
            required.append(normalized)
            seen.add(normalized)
    return required


def _capability_report(provider: str, required: list[str]) -> dict[str, object]:
    available = _DEFAULT_PROVIDER_CAPABILITIES.get(provider, set())
    missing = [capability for capability in required if capability not in available]
    return {
        "provider": provider,
        "required": required,
        "available": sorted(available),
        "missing": missing,
        "satisfied": not missing,
    }


def _normalize_patch_text(text: str) -> str:
    """Normalize indented multiline patch text back to a raw diff."""
    normalized = textwrap.dedent(text).strip()
    lines = normalized.splitlines()
    if lines:
        lines[0] = lines[0].lstrip()
    normalized = "\n".join(lines).strip()
    return normalized + "\n" if normalized else ""


def _extract_patch(text: str) -> str:
    """Pull a unified diff out of an LLM response.

    Strategies, in order:
      1. Triple-backtick block tagged ``diff`` or ``patch``.
      2. Any triple-backtick block whose body starts with ``diff --git``.
      3. Raw text starting with ``diff --git``.
      4. Empty string.
    """
    if not text:
        return ""

    for match in _PATCH_FENCE_RE.finditer(text):
        body = match.group("body")
        if body and "diff --git" in body:
            return _normalize_patch_text(body)

    diff_match = _DIFF_HEADER_RE.search(text)
    if diff_match:
        body = text[diff_match.start() :]
        return _normalize_patch_text(body)

    return ""


def _candidate_context_paths(instance: SWEBenchInstance) -> list[str]:
    """Infer likely source files from the problem statement.

    This is intentionally lightweight: the benchmark runner is not a full
    SWE-agent, but giving a single-shot model the directly mentioned source
    files avoids the pathological "patch without repository context" failure.
    """
    repo_root = instance.repo.split("/")[-1].replace("-", "_")
    text = instance.problem_statement
    candidates: list[str] = []

    def add(path: str) -> None:
        normalized = path.strip().strip("`'\"")
        if not normalized:
            return
        normalized = normalized.lstrip("./")
        if normalized.endswith(".py") and normalized not in candidates:
            candidates.append(normalized)

    for match in re.finditer(r"\bfrom\s+([A-Za-z_][\w.]*)\s+import\b", text):
        module = match.group(1)
        if module.startswith(f"{repo_root}.") or module == repo_root:
            add(f"{module.replace('.', '/')}.py")

    for match in re.finditer(r"\bimport\s+([A-Za-z_][\w.]*)\b", text):
        module = match.group(1)
        if module.startswith(f"{repo_root}.") or module == repo_root:
            add(f"{module.replace('.', '/')}.py")

    for match in re.finditer(r"(?<![A-Za-z0-9_./-])([A-Za-z0-9_./-]+\.py)\b", text):
        add(match.group(1))

    # If a package-qualified module is mentioned without an import statement,
    # include the corresponding source file as a final hint.
    dotted_re = re.compile(rf"\b({re.escape(repo_root)}(?:\.[A-Za-z_]\w*)+)\b")
    for match in dotted_re.finditer(text):
        add(f"{match.group(1).replace('.', '/')}.py")

    return candidates[:5]


def _fetch_github_file(repo: str, commit: str, path: str) -> str | None:
    if os.environ.get("SWE_BENCH_INCLUDE_SOURCE_CONTEXT", "1") in {"0", "false", "False"}:
        return None

    cache_key = (repo, commit, path)
    if cache_key in _SOURCE_CONTEXT_CACHE:
        return _SOURCE_CONTEXT_CACHE[cache_key]

    url = f"https://raw.githubusercontent.com/{repo}/{commit}/{path}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "eliza-swe-bench-context/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            raw = resp.read(160_000)
    except (urllib.error.URLError, TimeoutError, OSError):
        _SOURCE_CONTEXT_CACHE[cache_key] = None
        return None

    text = raw.decode("utf-8", errors="replace")
    if len(text) > 80_000:
        text = text[:80_000] + "\n# ... truncated ...\n"
    _SOURCE_CONTEXT_CACHE[cache_key] = text
    return text


def _build_source_context(instance: SWEBenchInstance) -> str:
    sections: list[str] = []
    for path in _candidate_context_paths(instance):
        content = _fetch_github_file(instance.repo, instance.base_commit, path)
        if not content:
            continue
        sections.append(f"### {path}\n```python\n{content}\n```")
    if not sections:
        return ""
    return "Relevant repository file snapshots at the base commit:\n\n" + "\n\n".join(sections)


def _build_prompt(instance: SWEBenchInstance, *, retry: bool = False) -> str:
    """Build a single prompt asking for a unified diff fix."""
    source_context = _build_source_context(instance)
    retry_prefix = (
        "Your previous response did not contain an applicable unified diff. "
        "This time return only the diff text, starting with `diff --git`.\n\n"
        if retry
        else ""
    )
    return (
        retry_prefix +
        "You are an expert software engineer fixing a real-world bug.\n\n"
        f"Repository: {instance.repo}\n"
        f"Base commit: {instance.base_commit}\n\n"
        "Problem statement:\n"
        f"{instance.problem_statement}\n\n"
        + (f"Hints:\n{instance.hints_text}\n\n" if instance.hints_text else "")
        + (f"{source_context}\n\n" if source_context else "")
        + "Respond with a SINGLE unified diff that resolves the issue. "
        "Start the response with `diff --git`; a fenced ```diff block is also acceptable. "
        "Do not include commentary outside the diff. The diff must be applicable with `git apply` from "
        "the repository root."
    )


async def _run_instance(
    client: object,
    instance: SWEBenchInstance,
    evaluator: SWEBenchEvaluator,
    provider_label: str | None = None,
) -> SWEBenchResult:
    """Run a single SWE-bench instance through the bridge."""
    started = time.time()
    task_id = f"{provider_label}:{instance.instance_id}" if provider_label else instance.instance_id
    try:
        send_message = client.send_message  # type: ignore[attr-defined]
        client.reset(task_id=task_id, benchmark="swe_bench")  # type: ignore[attr-defined]
        response = send_message(
            text=_build_prompt(instance),
            context={
                "benchmark": "swe_bench",
                "task_id": task_id,
                "instance_id": instance.instance_id,
                "provider": provider_label,
                "repo": instance.repo,
                "base_commit": instance.base_commit,
            },
        )
        text = getattr(response, "text", "") or ""
        patch = _extract_patch(text)
        if not patch:
            params = getattr(response, "params", None)
            if isinstance(params, dict) and params:
                patch = _extract_patch(json.dumps(params))
        if not patch:
            retry_response = send_message(
                text=_build_prompt(instance, retry=True),
                context={
                    "benchmark": "swe_bench",
                    "task_id": task_id,
                    "instance_id": instance.instance_id,
                    "provider": provider_label,
                    "repo": instance.repo,
                    "base_commit": instance.base_commit,
                    "phase": "patch_retry",
                    "goal": "return_diff_only",
                },
            )
            retry_text = getattr(retry_response, "text", "") or ""
            patch = _extract_patch(retry_text)
            if not patch:
                retry_params = getattr(retry_response, "params", None)
                if isinstance(retry_params, dict) and retry_params:
                    patch = _extract_patch(json.dumps(retry_params))
            if not patch:
                text = retry_text or text
    except Exception as exc:  # noqa: BLE001 — surface any client failure
        return SWEBenchResult(
            instance_id=instance.instance_id,
            generated_patch="",
            patch_status=PatchStatus.NOT_GENERATED,
            tests_passed=[],
            tests_failed=[],
            success=False,
            duration_seconds=time.time() - started,
            tokens_used=0,
            error=str(exc),
        )

    if not patch:
        preview = textwrap.shorten(text.replace("\n", " "), width=500, placeholder="...")
        return SWEBenchResult(
            instance_id=instance.instance_id,
            generated_patch="",
            patch_status=PatchStatus.NOT_GENERATED,
            tests_passed=[],
            tests_failed=[],
            success=False,
            duration_seconds=time.time() - started,
            tokens_used=0,
            error=f"no patch in response; preview={preview}",
        )

    result = await evaluator.evaluate_patch(instance, patch)
    result.duration_seconds = time.time() - started
    return result


async def _run_instances(
    client: object,
    instances: list[SWEBenchInstance],
    evaluator: SWEBenchEvaluator,
    provider_label: str | None = None,
) -> list[SWEBenchResult]:
    results: list[SWEBenchResult] = []
    for idx, inst in enumerate(instances):
        label = f" provider={provider_label}" if provider_label else ""
        logger.info(
            "[swe_bench] %d/%d %s%s",
            idx + 1,
            len(instances),
            inst.instance_id,
            label,
        )
        results.append(await _run_instance(client, inst, evaluator, provider_label))
    return results


def _mock_instance() -> SWEBenchInstance:
    return SWEBenchInstance(
        instance_id="mock__swe-bench-1",
        repo="mock/repo",
        base_commit="abc123",
        problem_statement="Update the greeting returned by hello.py.",
        hints_text=(
            "This synthetic smoke instance avoids dataset, Docker, and provider calls."
        ),
        created_at="2026-01-01",
        patch=(
            "diff --git a/hello.py b/hello.py\n"
            "--- a/hello.py\n"
            "+++ b/hello.py\n"
            "@@ -1 +1 @@\n"
            "-print('hello')\n"
            "+print('hello swe-bench')\n"
        ),
        test_patch="",
        fail_to_pass=["test_hello"],
        pass_to_pass=[],
    )


class _MockClient:
    def reset(self, *, task_id: str, benchmark: str) -> None:
        return None

    def send_message(self, *, text: str, context: dict[str, object]) -> object:
        return type(
            "MockResponse",
            (),
            {
                "text": (
                    "```diff\n"
                    "diff --git a/hello.py b/hello.py\n"
                    "--- a/hello.py\n"
                    "+++ b/hello.py\n"
                    "@@ -1 +1 @@\n"
                    "-print('hello')\n"
                    "+print('hello swe-bench')\n"
                    "```\n"
                )
            },
        )()


def _build_report(
    config: SWEBenchConfig,
    results: list[SWEBenchResult],
    instances_by_id: dict[str, SWEBenchInstance] | None = None,
) -> SWEBenchReport:
    total = len(results)
    resolved = sum(1 for r in results if r.success)
    applied = sum(
        1
        for r in results
        if r.patch_status
        in (PatchStatus.APPLIED, PatchStatus.TESTS_PASSED, PatchStatus.TESTS_FAILED)
    )
    avg_duration = sum(r.duration_seconds for r in results) / total if total else 0.0
    observed_tokens = [r.tokens_used for r in results if r.tokens_used is not None]
    avg_tokens = (
        sum(observed_tokens) / len(observed_tokens)
        if observed_tokens
        else 0.0
    )

    by_repo: dict[str, RepoStats] = {}
    grouped: dict[str, list[SWEBenchResult]] = {}
    for r in results:
        instance = instances_by_id.get(r.instance_id) if instances_by_id else None
        repo_key = instance.repo if instance else r.instance_id.split("-", 1)[0]
        grouped.setdefault(repo_key, []).append(r)
    for repo, rs in grouped.items():
        rresolved = sum(1 for r in rs if r.success)
        by_repo[repo] = RepoStats(
            total=len(rs),
            resolved=rresolved,
            resolve_rate=rresolved / len(rs) if rs else 0.0,
        )

    errors: dict[str, int] = {}
    for r in results:
        if r.error:
            errors[r.error] = errors.get(r.error, 0) + 1

    return SWEBenchReport(
        variant=config.variant.value,
        total_instances=total,
        resolved=resolved,
        unresolved=total - resolved,
        resolve_rate=resolved / total if total else 0.0,
        apply_rate=applied / total if total else 0.0,
        average_duration=avg_duration,
        average_tokens=avg_tokens,
        results=results,
        by_repo=by_repo,
        errors=errors,
    )


def _report_to_dict(report: SWEBenchReport) -> dict[str, object]:
    return {
        "summary": {
            "variant": report.variant,
            "total_instances": report.total_instances,
            "resolved": report.resolved,
            "unresolved": report.unresolved,
            "resolve_rate": report.resolve_rate,
            "apply_rate": report.apply_rate,
            "average_duration": report.average_duration,
            "average_tokens": report.average_tokens,
        },
        "by_repo": {
            k: {"total": v.total, "resolved": v.resolved, "resolve_rate": v.resolve_rate}
            for k, v in report.by_repo.items()
        },
        "errors": report.errors,
        "results": [
            {
                "instance_id": r.instance_id,
                "patch_status": r.patch_status.value,
                "status": r.status,
                "success": r.success,
                "duration_seconds": r.duration_seconds,
                "tokens_used": r.tokens_used,
                "tests_passed": r.tests_passed,
                "tests_failed": r.tests_failed,
                "error": r.error,
                "generated_patch_preview": (r.generated_patch or "")[:1500],
            }
            for r in report.results
        ],
    }


async def _run(args: argparse.Namespace) -> int:
    config = SWEBenchConfig(
        variant=SWEBenchVariant(args.variant),
        workspace_dir=args.workspace,
        output_dir=args.output,
        max_steps=args.max_steps,
        max_instances=args.max_instances,
        repo_filter=args.repo_filter,
        use_docker_eval=not args.no_docker,
        timeout_seconds=args.timeout,
        model_name=args.model or "eliza-ts-bridge",
    )
    Path(config.output_dir).mkdir(parents=True, exist_ok=True)

    if args.mock:
        instances = [_mock_instance()]
        client = _MockClient()
        eliza_server = None
    else:
        from eliza_adapter import ElizaClient, ElizaServerManager

        dataset = SWEBenchDataset(variant=config.variant)
        await dataset.load()
        instances = list(
            dataset.get_instances(
                repo_filter=config.repo_filter, limit=config.max_instances
            )
        )
        if not instances:
            print("No instances matched filters; aborting.", file=sys.stderr)
            return 2

        eliza_server = None
        if not os.environ.get("ELIZA_BENCH_URL"):
            eliza_server = ElizaServerManager()
            eliza_server.start()
            client = eliza_server.client
        else:
            client = ElizaClient()
            client.wait_until_ready(timeout=180)

    evaluator = SWEBenchEvaluator(
        workspace_dir=config.workspace_dir,
        timeout_seconds=config.timeout_seconds,
        use_docker=config.use_docker_eval,
    )
    instances_by_id = {instance.instance_id: instance for instance in instances}
    docker_ok = (
        await evaluator.check_docker_available() if config.use_docker_eval else False
    )
    if config.use_docker_eval and not docker_ok:
        logger.warning(
            "[swe_bench] docker not available; generated patches will be "
            "reported as incompatible"
        )

    try:
        timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        if args.orchestrated:
            providers = args.providers or [args.provider or "direct_shell"]
            required_capabilities = _parse_required_capabilities(
                args.required_capabilities
            )
            capability_reports = {
                provider: _capability_report(provider, required_capabilities)
                for provider in providers
            }
            if args.strict_capabilities:
                missing = {
                    provider: report["missing"]
                    for provider, report in capability_reports.items()
                    if report["missing"]
                }
                if missing:
                    payload = {
                        "summary": {
                            "variant": config.variant.value,
                            "total_instances": 0,
                            "resolved": 0,
                            "unresolved": 0,
                            "resolve_rate": 0.0,
                            "apply_rate": 0.0,
                            "average_duration": 0.0,
                            "average_tokens": 0.0,
                        },
                        "metrics": {
                            "overall_score": 0.0,
                            "provider_scores": {},
                        },
                        "matrix": {
                            "execution_mode": args.execution_mode,
                            "providers": providers,
                            "required_capabilities": required_capabilities,
                            "strict_capabilities": True,
                            "capabilities": capability_reports,
                        },
                        "orchestrated": {},
                        "error": f"Missing required capabilities: {missing}",
                    }
                    out_path = (
                        Path(config.output_dir)
                        / f"orchestrated-{timestamp}.json"
                    )
                    out_path.write_text(json.dumps(payload, indent=2))
                    print(json.dumps(payload["summary"], indent=2))
                    print(f"\nResult file: {out_path}")
                    return 2
            provider_payloads: dict[str, dict[str, object]] = {}
            provider_scores: dict[str, float] = {}
            all_results: list[SWEBenchResult] = []
            for provider in providers:
                provider_results = await _run_instances(
                    client,
                    instances,
                    evaluator,
                    provider_label=provider,
                )
                all_results.extend(provider_results)
                provider_report = _build_report(
                    config,
                    provider_results,
                    instances_by_id,
                )
                provider_payloads[provider] = _report_to_dict(provider_report)
                provider_scores[provider] = provider_report.resolve_rate

            summary_report = _build_report(config, all_results, instances_by_id)
            summary_payload = _report_to_dict(summary_report)
            overall_score = (
                sum(provider_scores.values()) / len(provider_scores)
                if provider_scores
                else 0.0
            )
            payload = {
                "summary": summary_payload["summary"],
                "metrics": {
                    "overall_score": overall_score,
                    "provider_scores": provider_scores,
                },
                "matrix": {
                    "execution_mode": args.execution_mode,
                    "providers": providers,
                    "required_capabilities": required_capabilities,
                    "strict_capabilities": args.strict_capabilities,
                    "capabilities": capability_reports,
                },
                "orchestrated": provider_payloads,
            }
            out_path = Path(config.output_dir) / f"orchestrated-{timestamp}.json"
        else:
            results = await _run_instances(client, instances, evaluator)
            report = _build_report(config, results, instances_by_id)
            payload = _report_to_dict(report)
            out_path = Path(config.output_dir) / f"swe-bench-{timestamp}.json"
    finally:
        if eliza_server is not None:
            eliza_server.stop()

    out_path.write_text(json.dumps(payload, indent=2))
    print(json.dumps(payload["summary"], indent=2))
    print(f"\nResult file: {out_path}")
    return 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="benchmarks.swe_bench.cli",
        description="Run SWE-bench through the eliza TS benchmark bridge.",
    )
    p.add_argument(
        "--variant",
        choices=["lite", "verified", "full"],
        default="lite",
        help="SWE-bench variant (default: lite)",
    )
    p.add_argument(
        "--max-instances",
        type=int,
        default=None,
        help="Cap on instances to run (default: all in variant)",
    )
    p.add_argument(
        "--repo-filter", default=None, help="Substring filter on repo name"
    )
    p.add_argument(
        "--workspace", default="./swe-bench-workspace", help="Workspace directory"
    )
    p.add_argument(
        "--output", default="./benchmark_results/swe-bench", help="Output directory"
    )
    p.add_argument("--max-steps", type=int, default=30)
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--no-docker", action="store_true", help="Skip docker evaluation")
    p.add_argument("--model", default=None, help="Model label for the report")
    p.add_argument("--provider", default=None, help="Provider label passed by registry")
    p.add_argument("--mock", action="store_true", help="Run a synthetic smoke instance")
    p.add_argument(
        "--orchestrated", action="store_true", help="Emit orchestrated result shape"
    )
    p.add_argument(
        "--execution-mode",
        choices=["orchestrated", "direct_shell"],
        default="orchestrated",
    )
    p.add_argument("--providers", nargs="+", default=None)
    p.add_argument("--matrix", action="store_true")
    p.add_argument("--no-baseline", action="store_true")
    p.add_argument("--allow-task-fallback", action="store_true")
    p.add_argument("--orchestrator-model", default=None)
    p.add_argument("--trace-dir", default=None)
    p.add_argument("--required-capabilities", default=None)
    p.add_argument("--strict-capabilities", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("SWE_BENCH_LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    args = _parse_args(argv)
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
