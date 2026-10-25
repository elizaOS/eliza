"""Release publishing: orchestrator."""

from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
from typing import Sequence
from eliza_training.manifest.eliza1_manifest import (  # noqa: E402
    ELIZA_1_HF_REPO,
    SUPPORTED_BACKENDS_BY_TIER,
)
from .context import EXIT_OK, OrchestratorError, PublishContext, _REPO_ROOT, log
from .evidence import validate_destination_repo, validate_release_evidence
from .layout import _build_upload_list, validate_bundle_layout
from .manifest import assemble_manifest, render_readme
from .upload import (
    _read_version,
    finalize_release_evidence,
    push_final_release_evidence,
    push_to_hf,
    run_hf_release_audit,
    tag_training_repo,
)
from .verification import run_eval_gates, run_kernel_verification


def run(ctx: PublishContext) -> int:
    """Run every stage. Returns an exit code; never raises."""

    try:
        validate_destination_repo(ctx)

        log.info("[stage 1/7] validate bundle layout (%s)", ctx.bundle_dir)
        layout = validate_bundle_layout(ctx)

        log.info("[stage 2/7] validate release evidence")
        release_evidence = validate_release_evidence(ctx, layout)

        log.info("[stage 3/7] kernel verification for tier %s", ctx.tier)
        backends = run_kernel_verification(ctx, layout)
        for b in SUPPORTED_BACKENDS_BY_TIER[ctx.tier]:
            log.info("  %s: %s (%s)", b, backends[b].status, backends[b].report)

        log.info("[stage 4/7] eval gates")
        gate_report, eval_blob = run_eval_gates(ctx)
        log.info(
            "  passed=%s, %d gates evaluated",
            gate_report.passed,
            len(gate_report.gates),
        )

        log.info("[stage 5/7] build + validate manifest")
        version = _read_version(ctx)
        manifest = assemble_manifest(
            ctx,
            layout=layout,
            backends=backends,
            gate_report=gate_report,
            eval_blob=eval_blob,
            version=version,
            release_evidence=release_evidence,
        )
        manifest_path = ctx.bundle_dir / "eliza-1.manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n")
        log.info(
            "  defaultEligible=%s, version=%s", manifest["defaultEligible"], version
        )

        log.info("[stage 6/7] render README")
        readme_text = render_readme(ctx, manifest)
        readme_path = ctx.bundle_dir / "README.md"
        readme_path.write_text(readme_text)

        if ctx.dry_run:
            log.info("\n--- manifest preview ---\n%s", json.dumps(manifest, indent=2))

        log.info(
            "[stage 7/7] push to %s%s", ctx.repo_id, " (dry-run)" if ctx.dry_run else ""
        )
        upload_pairs = _build_upload_list(ctx, layout)
        upload_evidence = push_to_hf(ctx, manifest_path, readme_path, upload_pairs)
        if upload_evidence is not None:
            log.info("[stage 7/7] finalize HF upload evidence")
            release_path, checksum_path = finalize_release_evidence(
                ctx,
                layout,
                upload_evidence,
            )
            push_final_release_evidence(ctx, release_path, checksum_path)

        log.info("[stage 7/7] audit published HF release surface")
        run_hf_release_audit(ctx)

        tag_name = tag_training_repo(ctx, version, ctx.dry_run)
        log.info("done. tag=%s", tag_name)
        return EXIT_OK

    except OrchestratorError as exc:
        log.error("orchestrator error: %s", exc)
        return exc.exit_code


def _parse_args(argv: Sequence[str] | None = None) -> PublishContext:
    ap = argparse.ArgumentParser(
        prog="python -m publish.orchestrator",
        description=(
            "End-to-end Eliza-1 bundle publisher. Runs layout validation, "
            "kernel verification, eval gates, manifest build, README "
            "render, and HF push as one pipeline. There is no flag to "
            "skip any check; --dry-run performs every check but does "
            "not push."
        ),
    )
    ap.add_argument(
        "--tier",
        required=True,
        choices=tuple(SUPPORTED_BACKENDS_BY_TIER.keys()),
        help="Eliza-1 device tier id.",
    )
    ap.add_argument(
        "--bundle-dir",
        required=True,
        type=Path,
        help="Path to the assembled bundle directory (text/, tts/, ...).",
    )
    ap.add_argument(
        "--repo-id",
        default=None,
        help=(
            f"HF repo id. Must equal {ELIZA_1_HF_REPO}; accepted only "
            "so wrappers can pass the resolved destination explicitly."
        ),
    )
    ap.add_argument(
        "--public",
        action="store_true",
        help="Create the HF repo as public on first publish (default: private).",
    )
    ap.add_argument(
        "--metal-verification",
        type=Path,
        default=None,
        help=(
            "Path to a previously-recorded metal_verify.json from a "
            "verified Metal host. Required when the tier supports Metal."
        ),
    )
    ap.add_argument(
        "--gates-path",
        type=Path,
        default=None,
        help="Override path to eliza1_gates.yaml (default: bundled).",
    )
    ap.add_argument(
        "--prior-bundle-aggregate",
        type=Path,
        default=None,
        help=(
            "Path to the previously-published bundle's evals/aggregate.json. "
            "When set, the eval gate runs an extra regression check: no key "
            "metric (text_eval / voice_rtf / asr_wer) may slip below the "
            "prior bundle's value by more than --regression-tolerance. "
            "Omit on first publish."
        ),
    )
    ap.add_argument(
        "--regression-tolerance",
        type=float,
        default=0.05,
        help=(
            "Fractional tolerance for the prior-bundle regression gate "
            "(default 0.05 = 5%%). Ignored when --prior-bundle-aggregate "
            "is not provided."
        ),
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Run every check but do not push to HF or tag git.",
    )
    args = ap.parse_args(argv)

    repo_id = args.repo_id or ELIZA_1_HF_REPO
    template_path = Path(__file__).resolve().parent / "templates" / "README.md.j2"

    return PublishContext(
        tier=args.tier,
        bundle_dir=args.bundle_dir.resolve(),
        dry_run=args.dry_run,
        metal_verification=(
            args.metal_verification.resolve() if args.metal_verification else None
        ),
        repo_id=repo_id,
        public=args.public,
        training_repo_root=_REPO_ROOT,
        template_path=template_path,
        gates_path=args.gates_path,
        prior_bundle_aggregate=(
            args.prior_bundle_aggregate.resolve()
            if args.prior_bundle_aggregate
            else None
        ),
        regression_tolerance=args.regression_tolerance,
    )


def main(argv: Sequence[str] | None = None) -> int:
    ctx = _parse_args(argv)
    return run(ctx)


if __name__ == "__main__":
    sys.exit(main())
