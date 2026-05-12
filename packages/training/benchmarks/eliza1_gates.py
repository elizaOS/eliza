"""Eliza-1 eval gates.

The publish orchestrator (``scripts/publish/orchestrator.py``, stage 4)
loads ``<bundle>/evals/aggregate.json`` and calls :func:`apply_gates` on
it; it refuses to publish unless :attr:`GateReport.passed` is True. The
training pipeline (``scripts/run_pipeline.py``) writes the same
``aggregate.json`` after benchmarking and runs :func:`apply_gates` itself
for an early go/no-go signal.

Aggregate eval blob shape
-------------------------

::

    {
      "tier": "0_6b",                 # Eliza-1 device tier id, OR a
                                      # registry/public name like
                                      # "eliza-1-0_6b" (normalized here).
      "mode": "smoke" | "full",       # optional; "full" if omitted.
      "results": {                    # measured metrics; see eliza1_gates.yaml
        "text_eval": 0.71,
        "format_ok": 0.83,            # parsable-output rate (0..1)
        "format_ok_base": 0.61,       # base model's format_ok (smoke mode)
        "voice_rtf": 0.32,
        "asr_wer": 0.05,
        "thirty_turn_ok": true,
        ...
      }
    }

For convenience :func:`apply_gates` also accepts a bare ``results`` dict
plus an explicit ``tier`` string::

    apply_gates({"format_ok": 0.6}, "eliza-1-0_6b")

Smoke mode
----------

When ``mode == "smoke"`` only the structural gates run:

1. the pipeline produced any results at all,
2. the fine-tuned model's ``format_ok`` rate clears a low floor (0.5),
3. the fine-tuned model's ``format_ok`` is not worse than the base
   model's ``format_ok`` (when a base measurement is present).

Numeric quality/latency thresholds are skipped in smoke mode — they are
``provisional`` (unmeasured) and would trip a green run for the wrong
reason.
"""

from __future__ import annotations

import operator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

import yaml

_GATES_YAML = Path(__file__).resolve().parent / "eliza1_gates.yaml"

# Tier ids recognised by the manifest module. Kept local to avoid a hard
# import of scripts.manifest from a package that publish/orchestrator.py
# imports very early.
KNOWN_TIERS: tuple[str, ...] = (
    "0_6b",
    "1_7b",
    "9b",
    "27b",
    "27b-256k",
    "27b-1m",
)

_OPS: dict[str, Any] = {
    ">=": operator.ge,
    ">": operator.gt,
    "<=": operator.le,
    "<": operator.lt,
    "==": operator.eq,
}

_FORMAT_FLOOR = 0.5


# ---------------------------------------------------------------------------
# Report types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GateRow:
    """Outcome of one gate."""

    name: str
    passed: bool
    reason: str
    metric: str | None = None
    observed: Any = None
    threshold: Any = None
    op: str | None = None
    provisional: bool = False
    skipped: bool = False
    required: bool = True


@dataclass
class GateReport:
    """Aggregate gate outcome.

    ``passed`` is True iff no *required* gate failed. ``failures`` is the
    list of human-readable failure strings (one per failed required gate);
    ``failed_gates`` is the matching list of :class:`GateRow`. ``details``
    carries enough structured context to render a publish-block message or
    a training-run summary.
    """

    tier: str
    mode: str
    gates: list[GateRow] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not any(g.required and not g.passed and not g.skipped for g in self.gates)

    @property
    def failed_gates(self) -> list[GateRow]:
        return [g for g in self.gates if g.required and not g.passed and not g.skipped]

    @property
    def failures(self) -> list[str]:
        return [f"{g.name}: {g.reason}" for g in self.failed_gates]

    @property
    def details(self) -> dict[str, Any]:
        return {
            "tier": self.tier,
            "mode": self.mode,
            "passed": self.passed,
            "gates": [
                {
                    "name": g.name,
                    "passed": g.passed,
                    "skipped": g.skipped,
                    "required": g.required,
                    "provisional": g.provisional,
                    "metric": g.metric,
                    "observed": g.observed,
                    "op": g.op,
                    "threshold": g.threshold,
                    "reason": g.reason,
                }
                for g in self.gates
            ],
            "failures": self.failures,
        }

    def to_dict(self) -> dict[str, Any]:
        return self.details


# ---------------------------------------------------------------------------
# Loading + tier normalisation
# ---------------------------------------------------------------------------


GatesDoc = dict[str, Any]


def load_gates(path: str | Path | None = None) -> GatesDoc:
    """Load the gate-definition document (default: bundled ``eliza1_gates.yaml``).

    Two schema shapes are accepted:

    * **v2** (current): a top-level ``gates`` map (name → ``op``/``unit``/
      ``manifest_field``/``needs_hardware`` metadata, no threshold) plus a
      ``tiers`` map (tier → name → ``threshold``/``required``/``provisional``/
      ``needs_hardware``). The per-tier ``required`` flag decides whether a
      failing gate is publish-blocking; ``needs_hardware`` gates that have no
      measurement are recorded as "needs-hardware" (skipped), not as a fail.
    * **v1** (legacy): a ``defaults`` map (name → full gate spec including
      ``threshold``/``op``/``required_for``) plus an optional ``tiers`` map of
      per-tier overrides. Still understood for back-compat.
    """
    p = Path(path) if path is not None else _GATES_YAML
    doc = yaml.safe_load(p.read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or not (("gates" in doc) or ("defaults" in doc)):
        raise ValueError(
            f"{p}: not a gate-definition document (missing 'gates' / 'defaults')"
        )
    return doc


def normalize_tier(value: str | None) -> str:
    """Map a tier id or registry/public name to the canonical tier id.

    ``"eliza-1-0_6b"`` → ``"0_6b"``; ``"0_6b"`` → ``"0_6b"``;
    ``"eliza-1-27b-256k"`` → ``"27b-256k"``.
    """
    if not value:
        raise ValueError("tier is required (got empty value)")
    t = str(value).strip()
    if t in KNOWN_TIERS:
        return t
    if t.startswith("eliza-1-"):
        suffix = t[len("eliza-1-"):]
        if suffix in KNOWN_TIERS:
            return suffix
    # Tolerate stray casing/separators on the registry-name path only.
    norm = t.replace("eliza_1_", "").replace("eliza-1-", "")
    if norm in KNOWN_TIERS:
        return norm
    raise ValueError(f"unknown Eliza-1 tier {value!r}; expected one of {KNOWN_TIERS}")


# ---------------------------------------------------------------------------
# Gate evaluation
# ---------------------------------------------------------------------------


def _gate_specs_for_tier(doc: GatesDoc, tier: str) -> dict[str, dict[str, Any]]:
    """Return ``name -> merged-spec`` for ``tier``.

    For the v2 schema each entry merges the global ``gates[name]`` metadata
    (``op``, ``unit``, ``manifest_field``, ``needs_hardware``) with the
    per-tier row from ``tiers[tier][name]`` (``threshold``, ``required``,
    ``provisional``, optional ``needs_hardware`` override). Only gates that
    have a per-tier row are evaluated for that tier.

    For the v1 schema each entry is ``defaults[name]`` overridden by
    ``tiers[tier][name]``; every default gate is evaluated.
    """
    tier_rows = (doc.get("tiers") or {}).get(tier) or {}

    if "gates" in doc:
        gate_meta = doc.get("gates") or {}
        specs: dict[str, dict[str, Any]] = {}
        for name, row in tier_rows.items():
            merged = dict(gate_meta.get(name) or {})
            merged.update(row or {})
            # v2 carries no "metric" — the gate name *is* the result key.
            merged.setdefault("metric", name)
            specs[name] = merged
        return specs

    # v1 legacy.
    specs = {}
    for name, spec in (doc.get("defaults") or {}).items():
        specs[name] = dict(spec or {})
    for name, spec in tier_rows.items():
        merged = dict(specs.get(name, {}))
        merged.update(spec or {})
        specs[name] = merged
    return specs


def _is_required(spec: Mapping[str, Any], tier: str) -> bool:
    # v2: per-tier ``required`` bool. v1: ``required_for`` list / "all".
    if "required" in spec:
        return bool(spec.get("required"))
    req = spec.get("required_for", "all")
    if req in (None, "all"):
        return True
    if isinstance(req, str):
        return req == tier
    if isinstance(req, Iterable):
        return tier in set(req)
    return True


# Normalise the v2 ``op`` vocabulary onto the comparison set used internally.
_OP_ALIASES = {"bool": "is_true"}

# Release channels — mirrors ``ELIZA_1_RELEASE_CHANNELS`` in the manifest
# module. ``base-v1`` is the upstream-base + kernel-optimized release; its
# text weights ARE the upstream base GGUFs (not the fine-tuned Eliza-1), so
# the held-out *text-quality* gate (`text_eval`) is N/A for that channel —
# it is still recorded/reported, just not publish-blocking. EVERYTHING else
# (voice RTF, ASR WER, VAD, e2e loop, 30-turn, dflash bench) stays exactly as
# required as on the recommended channel — `base-v1` does NOT mean "skip the
# runnable-on-base evals".
RELEASE_CHANNELS = ("recommended", "base-v1")
DEFAULT_RELEASE_CHANNEL = "recommended"
# Gates demoted from required → informational on the `base-v1` channel.
_BASE_V1_NOT_REQUIRED_GATES = frozenset({"text_eval"})


def _eval_one(
    name: str,
    spec: Mapping[str, Any],
    results: Mapping[str, Any],
    tier: str,
    release_channel: str = DEFAULT_RELEASE_CHANNEL,
) -> GateRow:
    metric = spec.get("metric", name)
    op_name = _OP_ALIASES.get(str(spec.get("op", ">=")), str(spec.get("op", ">=")))
    threshold = spec.get("threshold")
    provisional = bool(spec.get("provisional", False))
    needs_hardware = bool(spec.get("needs_hardware", False))
    required = _is_required(spec, tier)
    if release_channel == "base-v1" and name in _BASE_V1_NOT_REQUIRED_GATES:
        # Held-out text quality is the fine-tuned-v1/v2 deliverable; the
        # base-v1 channel ships the upstream base text weights. Record the
        # number, do not block on it.
        required = False

    if metric not in results or results.get(metric) is None:
        # A missing measurement on a required gate is publish-blocking (the
        # orchestrator's eval stage wants it to fail loudly rather than be
        # silently treated as a pass) — UNLESS the gate is hardware-bound
        # (e.g. mobile RSS / thermal): on a host that lacks that device the
        # measurement is genuinely unavailable, so it is recorded as
        # "needs-hardware" (skipped) per eliza1_gates.yaml's header rule,
        # not faked. The CI matrix runs hardware gates on real devices.
        if required and needs_hardware:
            return GateRow(
                name=name,
                passed=True,
                reason=(
                    f"needs-hardware: {metric!r} has no measurement on this "
                    f"host (device-bound gate; CI matrix runs it on hardware)"
                ),
                metric=metric,
                observed=None,
                threshold=threshold,
                op=op_name,
                provisional=provisional,
                skipped=True,
                required=required,
            )
        return GateRow(
            name=name,
            passed=not required,
            reason=(
                f"missing measurement results.{metric!r}"
                if required
                else f"not measured (gate not required for tier {tier})"
            ),
            metric=metric,
            observed=None,
            threshold=threshold,
            op=op_name,
            provisional=provisional,
            skipped=not required,
            required=required,
        )

    observed = results[metric]

    if op_name == "is_true":
        ok = bool(observed) is True
        return GateRow(name, ok, f"{metric}={observed!r}; want truthy", metric,
                       observed, True, op_name, provisional, False, required)
    if op_name == "is_false":
        ok = bool(observed) is False
        return GateRow(name, ok, f"{metric}={observed!r}; want falsy", metric,
                       observed, False, op_name, provisional, False, required)

    cmp = _OPS.get(op_name)
    if cmp is None:
        return GateRow(name, False, f"unknown op {op_name!r} in gate {name!r}", metric,
                       observed, threshold, op_name, provisional, False, required)
    if threshold is None:
        return GateRow(name, False, f"gate {name!r} for tier {tier} has no threshold",
                       metric, observed, threshold, op_name, provisional, False, required)
    try:
        ok = bool(cmp(float(observed), float(threshold)))
    except (TypeError, ValueError):
        return GateRow(name, False, f"{metric}={observed!r} not numeric", metric,
                       observed, threshold, op_name, provisional, False, required)
    return GateRow(name, ok, f"{metric}={observed} {op_name} {threshold}", metric,
                   observed, threshold, op_name, provisional, False, required)


def _smoke_report(tier: str, results: Mapping[str, Any]) -> GateReport:
    gates: list[GateRow] = []

    # 1. pipeline produced results at all.
    has_any = any(v is not None for v in results.values()) if results else False
    gates.append(GateRow(
        name="pipeline_ran",
        passed=has_any,
        reason="no metrics in results" if not has_any else "results present",
        metric=None, observed=None, threshold=None, op=None,
        provisional=True, skipped=False, required=True,
    ))

    # 2. fine-tuned format_ok above the floor.
    fmt = results.get("format_ok")
    if fmt is None:
        gates.append(GateRow(
            name="format_ok_floor", passed=False,
            reason="missing results.format_ok", metric="format_ok",
            observed=None, threshold=_FORMAT_FLOOR, op=">=",
            provisional=True, skipped=False, required=True,
        ))
    else:
        try:
            fmt_v = float(fmt)
        except (TypeError, ValueError):
            gates.append(GateRow("format_ok_floor", False,
                                 f"results.format_ok={fmt!r} not numeric", "format_ok",
                                 fmt, _FORMAT_FLOOR, ">=", True, False, True))
        else:
            gates.append(GateRow("format_ok_floor", fmt_v >= _FORMAT_FLOOR,
                                 f"format_ok={fmt_v} >= {_FORMAT_FLOOR}", "format_ok",
                                 fmt_v, _FORMAT_FLOOR, ">=", True, False, True))

    # 3. fine-tuned format_ok not worse than base (when base measured).
    base = results.get("format_ok_base", results.get("base_format_ok"))
    if base is None:
        gates.append(GateRow(
            name="format_ok_not_regressed", passed=True, skipped=True,
            reason="no base-model format_ok measurement to compare against",
            metric="format_ok", observed=fmt, threshold=base, op=">=",
            provisional=True, required=True,
        ))
    else:
        try:
            ok = float(fmt) >= float(base)
            reason = f"finetuned format_ok={float(fmt)} >= base format_ok={float(base)}"
        except (TypeError, ValueError):
            ok = False
            reason = f"format_ok={fmt!r} / base={base!r} not numeric"
        gates.append(GateRow("format_ok_not_regressed", ok, reason, "format_ok",
                             fmt, base, ">=", True, False, True))

    return GateReport(tier=tier, mode="smoke", gates=gates)


def _full_report(
    tier: str,
    results: Mapping[str, Any],
    doc: GatesDoc,
    release_channel: str = DEFAULT_RELEASE_CHANNEL,
) -> GateReport:
    specs = _gate_specs_for_tier(doc, tier)
    gates = [
        _eval_one(name, spec, results, tier, release_channel)
        for name, spec in specs.items()
    ]
    return GateReport(tier=tier, mode="full", gates=gates)


def _unwrap(
    blob_or_results: Mapping[str, Any],
) -> tuple[str | None, str | None, Mapping[str, Any]]:
    """Return ``(tier, mode, results)`` for either an aggregate blob or a flat dict."""
    if "results" in blob_or_results and isinstance(blob_or_results["results"], Mapping):
        tier = blob_or_results.get("tier")
        mode = blob_or_results.get("mode") or blob_or_results.get("eval_mode")
        return tier, mode, blob_or_results["results"]
    return None, None, blob_or_results


def apply_gates(
    eval_blob: Mapping[str, Any],
    gates_or_tier: GatesDoc | str | None = None,
    *,
    tier: str | None = None,
    mode: str | None = None,
    gates: GatesDoc | None = None,
    release_channel: str | None = None,
) -> GateReport:
    """Evaluate ``eval_blob`` against the tier gate set.

    ``eval_blob`` may be a full aggregate blob (``{"tier", "mode", "results"}``)
    or a bare results dict. ``gates_or_tier`` is overloaded: a ``str`` is a
    tier override, a ``dict`` is a pre-loaded gate document, ``None`` loads
    the bundled ``eliza1_gates.yaml``. ``tier`` / ``mode`` / ``gates``
    keyword args take precedence over anything inferred from the blob.
    ``release_channel`` (``"recommended"`` default, or ``"base-v1"``) relaxes
    the held-out text-quality gate on the base-v1 channel — every other gate
    stays required.
    """
    if isinstance(gates_or_tier, str):
        tier = tier or gates_or_tier
    elif isinstance(gates_or_tier, Mapping):
        gates = gates if gates is not None else gates_or_tier

    channel = (release_channel or DEFAULT_RELEASE_CHANNEL)
    if channel not in RELEASE_CHANNELS:
        raise ValueError(
            f"release_channel must be one of {RELEASE_CHANNELS}, got {channel!r}"
        )

    blob_tier, blob_mode, results = _unwrap(eval_blob)
    tier_id = normalize_tier(tier or blob_tier)
    eval_mode = (mode or blob_mode or "full").lower()
    if eval_mode not in ("smoke", "full"):
        raise ValueError(f"mode must be 'smoke' or 'full', got {eval_mode!r}")

    if eval_mode == "smoke":
        return _smoke_report(tier_id, results)

    doc = gates if gates is not None else load_gates()
    return _full_report(tier_id, results, doc, channel)
