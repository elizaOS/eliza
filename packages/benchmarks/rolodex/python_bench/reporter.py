"""Reporter v2 — full trace output with colour, per-item verdict.

Port of the TypeScript reporter.ts.
"""

from __future__ import annotations

from .types import (
    Conversation,
    Extraction,
    ItemTrace,
    Metrics,
    RelationshipMetrics,
)

# ── ANSI colour codes ────────────────────────────

G = "\033[32m"  # green
R = "\033[31m"  # red
Y = "\033[33m"  # yellow
D = "\033[2m"   # dim
B = "\033[1m"   # bold
X = "\033[0m"   # reset


def _pct(n: float) -> str:
    return f"{n * 100:.1f}%"


# ── Public API ────────────────────────────────────


def header(title: str) -> None:
    """Print a bold section header."""
    bar = "\u2550" * 90
    print(f"\n{bar}\n  {B}{title}{X}\n{bar}\n")


def print_conv_trace(
    conv: Conversation,
    ext: Extraction,
    id_items: list[ItemTrace],
    rel_items: list[ItemTrace],
    trust_items: list[ItemTrace],
) -> None:
    """Print per-conversation trace with messages, handler traces, and scoring."""
    print(f"  \u250c\u2500\u2500 {B}{conv.id}{X}: {conv.name} [{conv.platform}/{conv.room}]")

    # Messages
    for m in conv.messages:
        text_preview = m.text[:100]
        print(f"  \u2502 {D}[{m.display_name}]{X} {text_preview}")

    # Handler traces
    if ext.traces:
        print("  \u2502")
        for t in ext.traces:
            print(f"  \u2502 {D}\u2192 {t}{X}")

    # Identities
    if conv.expected.identities or ext.identities:
        print("  \u2502")
        print(
            f"  \u2502 {B}Identities{X}  expected: {len(conv.expected.identities)}"
            f"  got: {len(ext.identities)}"
        )
        for item in id_items:
            icon = f"{G}\u2713{X}" if item.status == "TP" else f"{R}\u2717 {item.status}{X}"
            print(f"  \u2502   {icon} {item.label} {D}{item.detail}{X}")

    # Relationships
    if conv.expected.relationships or ext.relationships:
        print("  \u2502")
        print(
            f"  \u2502 {B}Relationships{X}  expected: {len(conv.expected.relationships)}"
            f"  got: {len(ext.relationships)}"
        )
        for item in rel_items:
            if item.status == "TP":
                icon = f"{G}\u2713{X}"
            elif item.status == "PARTIAL":
                icon = f"{Y}~ PARTIAL{X}"
            else:
                icon = f"{R}\u2717 {item.status}{X}"
            print(f"  \u2502   {icon} {item.label} {D}{item.detail}{X}")

    # Trust
    if conv.expected.trust_signals or ext.trust_signals:
        print("  \u2502")
        print(
            f"  \u2502 {B}Trust{X}  expected: {len(conv.expected.trust_signals)}"
            f"  got: {len(ext.trust_signals)}"
        )
        for item in trust_items:
            icon = f"{G}\u2713{X}" if item.status == "TP" else f"{R}\u2717 {item.status}{X}"
            print(f"  \u2502   {icon} {item.label} {D}{item.detail}{X}")

    print("  \u2514\u2500\u2500\n")


def print_metric(label: str, m: Metrics, extra: str = "") -> None:
    """Print a single metric line."""
    if m.f1 == 1.0:
        status = f"{G}PERFECT{X}"
    elif m.f1 >= 0.8:
        status = f"{Y}GOOD{X}"
    else:
        status = f"{R}NEEDS WORK{X}"
    e = f"  {extra}" if extra else ""
    print(
        f"  {label:<28} "
        f"P:{_pct(m.precision):>7}  "
        f"R:{_pct(m.recall):>7}  "
        f"F1:{_pct(m.f1):>7}  "
        f"(TP:{m.tp} FP:{m.fp} FN:{m.fn})  "
        f"{status}{e}"
    )


def print_rel_metric(label: str, m: RelationshipMetrics) -> None:
    """Print a relationship metric line with type accuracy."""
    print_metric(label, m, extra=f"TypeAccuracy: {_pct(m.type_accuracy)}")


def print_resolution_trace(
    items: list[ItemTrace],
    traces: list[str],
    fmr: float,
) -> None:
    """Print entity resolution trace."""
    print(f"  \u250c\u2500\u2500 {B}Entity Resolution{X}")
    if traces:
        for t in traces:
            print(f"  \u2502 {D}\u2192 {t}{X}")
        print("  \u2502")
    for item in items:
        icon = f"{G}\u2713{X}" if item.status == "TP" else f"{R}\u2717 {item.status}{X}"
        print(f"  \u2502 {icon} {item.label} {D}{item.detail}{X}")
    print(f"  \u2502 False Merge Rate: {_pct(fmr)}")
    print("  \u2514\u2500\u2500\n")


def print_comparison(
    handlers: list[dict[str, float | str]],
) -> None:
    """Print the comparison table across handlers."""
    header("COMPARISON")
    h = (
        "  "
        + "Handler".ljust(28)
        + "Identity".ljust(10)
        + "Relation".ljust(10)
        + "Trust".ljust(10)
        + "Resolve".ljust(10)
        + "FMR".ljust(8)
        + "TypeAcc".ljust(10)
        + "Time"
    )
    print(h)
    print("  " + "\u2500" * 95)
    for c in handlers:
        name = str(c["name"])[:27]
        print(
            "  "
            + name.ljust(28)
            + _pct(float(c["id_f1"])).ljust(10)
            + _pct(float(c["rel_f1"])).ljust(10)
            + _pct(float(c["tr_f1"])).ljust(10)
            + _pct(float(c["res_f1"])).ljust(10)
            + _pct(float(c["fmr"])).ljust(8)
            + _pct(float(c["type_acc"])).ljust(10)
            + f"{float(c['ms']):.1f}ms"
        )
    print()
