#!/usr/bin/env python3
"""Aggregate bipedal-walking + continual-learning + text-conditioning evidence.

Reads whichever of the known evidence sources exist under a configurable base
directory and emits a single master markdown report. Missing sources are
skipped gracefully and recorded in the status section; the script never crashes
on a missing file.

Pure stdlib (json + pathlib). No jax, no GPU, CPU-only.

Sources (all relative to ``--base``):
  checkpoints/biped_walk_berkeley/metrics.json        PPO reward curve
  checkpoints/biped_walk_berkeley/walk_eval.json      multi-command walk eval
  evidence/bipedal_walking/continual_skills/continual_skills.json
                                                      multihead-vs-finetune CL
  evidence/alberta_retention_tournament/TOURNAMENT_REPORT.md   retention tournament
  evidence/alberta_retention_v2/SUMMARY.json          5-task/3-seed CL ablation
  evidence/bipedal_walking/REWARD_AND_APPROACH.md     reward design writeup
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

# Source paths relative to the base dir. Resolved against --base at runtime.
REL_METRICS = "checkpoints/biped_walk_berkeley/metrics.json"
REL_WALK_EVAL = "checkpoints/biped_walk_berkeley/walk_eval.json"
REL_CONTINUAL = "evidence/bipedal_walking/continual_skills/continual_skills.json"
REL_TOURNAMENT = "evidence/alberta_retention_tournament/TOURNAMENT_REPORT.md"
REL_RETENTION_V2 = "evidence/alberta_retention_v2/SUMMARY.json"
REL_REWARD = "evidence/bipedal_walking/REWARD_AND_APPROACH.md"
DEFAULT_OUT = "evidence/bipedal_walking/MASTER_REPORT.md"


def _load_json(path: Path):
    """Return parsed JSON, or None if missing/unparseable (never raises)."""
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError, ValueError):
        return None


def _rel(path: Path, base: Path) -> str:
    """Path relative to base for use inside the report (markdown links)."""
    try:
        return path.relative_to(base).as_posix()
    except ValueError:
        return path.as_posix()


def _num(value) -> str:
    """Format a number compactly; pass through non-numbers as str."""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        if isinstance(value, float):
            return f"{value:.3f}"
        return str(value)
    return str(value)


def _check(flag) -> str:
    return "yes" if flag else "no"


# --------------------------------------------------------------------------
# Section builders. Each takes the loaded source (or None) and returns a list
# of markdown lines, plus an entry is recorded separately for the status table.
# --------------------------------------------------------------------------


def _sparkline(rewards: list[float]) -> str:
    """Tiny unicode bar sparkline over the reward curve."""
    blocks = "▁▂▃▄▅▆▇█"
    if not rewards:
        return ""
    lo, hi = min(rewards), max(rewards)
    span = hi - lo
    if span <= 0:
        return blocks[0] * len(rewards)
    out = []
    for r in rewards:
        idx = int(round((r - lo) / span * (len(blocks) - 1)))
        out.append(blocks[max(0, min(len(blocks) - 1, idx))])
    return "".join(out)


def section_walks(metrics, walk_eval) -> list[str]:
    lines = ["## 2. Does it walk?", ""]

    # --- training reward curve ---
    if isinstance(metrics, list) and metrics:
        points = [p for p in metrics if isinstance(p, dict) and "reward" in p]
        rewards = [float(p["reward"]) for p in points]
        if rewards:
            final = rewards[-1]
            best = max(rewards)
            final_steps = points[-1].get("steps", "?")
            lines += [
                "### Training reward (brax PPO)",
                "",
                f"- Final reward: **{final:.3f}** at {final_steps} steps",
                f"- Best reward: **{best:.3f}**  ·  start: {rewards[0]:.3f}",
                f"- Reward curve: `{_sparkline(rewards)}` ({len(rewards)} logged points)",
                "",
                "| steps | reward | fps |",
                "|---:|---:|---:|",
            ]
            for p in points[-5:]:
                lines.append(
                    f"| {p.get('steps', '?')} | {_num(p.get('reward'))} "
                    f"| {_num(p.get('fps', ''))} |"
                )
            lines.append("")
        else:
            lines += ["_metrics.json present but contained no reward points._", ""]
    else:
        lines += [
            "_PPO training metrics (`metrics.json`) not found — reward curve pending._",
            "",
        ]

    # --- multi-command walk eval ---
    if isinstance(walk_eval, dict) and isinstance(walk_eval.get("commands"), dict):
        cmds = walk_eval["commands"]
        n_followed = walk_eval.get("n_commands_followed", "?")
        n_total = walk_eval.get("n_commands", len(cmds))
        walks = walk_eval.get("walks_and_follows")
        lines += [
            "### Walk eval (per-command following)",
            "",
            f"Env: `{walk_eval.get('env', '?')}`  ·  "
            f"followed **{n_followed}/{n_total}** commands  ·  "
            f"walks forward: **{_check(walks)}**",
            "",
            "| command | cmd [vx,vy,yaw] | Δx (m) | Δy (m) | Δyaw (rad) | fell | follows |",
            "|---|---|---:|---:|---:|:--:|:--:|",
        ]
        for text, c in cmds.items():
            if not isinstance(c, dict):
                continue
            cmd = c.get("command", [])
            cmd_str = (
                "[" + ", ".join(_num(v) for v in cmd) + "]"
                if isinstance(cmd, list)
                else str(cmd)
            )
            lines.append(
                f"| {text} | {cmd_str} | {_num(c.get('delta_x_m'))} "
                f"| {_num(c.get('delta_y_m'))} | {_num(c.get('delta_yaw_rad'))} "
                f"| {_check(c.get('fell'))} | {_check(c.get('follows_goal'))} |"
            )
        lines.append("")
    else:
        lines += [
            "_Walk eval (`walk_eval.json`) not found — per-command following pending._",
            "",
        ]
    return lines


def section_text_conditioning(walk_eval, continual) -> list[str]:
    lines = ["## 3. Text conditioning", ""]
    lines += [
        "Free text maps deterministically to a joystick command `[vx, vy, yaw]`; "
        "the same trained policy pursues whichever goal the command vector encodes "
        "(`resolve_command` in `joystick_text.py`). No retraining per instruction.",
        "",
    ]

    # text -> command mapping (prefer continual report's explicit map)
    text_map = None
    if isinstance(continual, dict) and isinstance(continual.get("text_to_command"), dict):
        text_map = continual["text_to_command"]
    elif isinstance(walk_eval, dict) and isinstance(walk_eval.get("commands"), dict):
        text_map = {
            t: c.get("command")
            for t, c in walk_eval["commands"].items()
            if isinstance(c, dict)
        }

    if text_map:
        lines += [
            "### Text → joystick command",
            "",
            "| text | command [vx, vy, yaw] |",
            "|---|---|",
        ]
        for text, cmd in text_map.items():
            cmd_str = (
                "[" + ", ".join(_num(v) for v in cmd) + "]"
                if isinstance(cmd, list)
                else str(cmd)
            )
            lines.append(f"| {text} | {cmd_str} |")
        lines.append("")
    else:
        lines += [
            "_No text→command mapping found yet (needs `walk_eval.json` or "
            "`continual_skills.json`)._",
            "",
        ]

    # which commands the policy actually follows
    if isinstance(walk_eval, dict) and isinstance(walk_eval.get("commands"), dict):
        followed = [
            t
            for t, c in walk_eval["commands"].items()
            if isinstance(c, dict) and c.get("follows_goal")
        ]
        not_followed = [
            t
            for t, c in walk_eval["commands"].items()
            if isinstance(c, dict) and not c.get("follows_goal")
        ]
        lines += [
            "### Commands the trained policy follows",
            "",
            f"- Followed: {', '.join(followed) if followed else '_(none)_'}",
            f"- Not followed: {', '.join(not_followed) if not_followed else '_(none)_'}",
            "",
        ]
    return lines


def section_continual(continual, tournament_exists, tournament_rel, retention_v2) -> list[str]:
    lines = ["## 4. Continual learning", ""]
    lines += [
        "Skills (text-command walking behaviours) are learned **sequentially**. "
        "`multihead` keeps per-command heads over a consolidated trunk (Alberta "
        "retention) and **retains** earlier skills; `finetune` retrains a single "
        "shared head per command and **forgets** them.",
        "",
    ]

    # --- multihead vs finetune ---
    if isinstance(continual, dict) and isinstance(continual.get("continual"), dict):
        cl = continual["continual"]
        lines += [
            "### Multihead (retain) vs finetune (forget)",
            "",
            "| student | ACC ↑ | BWT ↑ (0 = no forgetting) | Forgetting ↓ |",
            "|---|---:|---:|---:|",
        ]
        for mode, r in cl.items():
            if not isinstance(r, dict):
                continue
            lines.append(
                f"| `{mode}` | {_num(r.get('acc'))} | {_num(r.get('bwt'))} "
                f"| {_num(r.get('forgetting'))} |"
            )
        lines.append("")

        rollout = continual.get("rollout")
        if isinstance(rollout, dict) and rollout:
            mh = rollout.get("multihead", {}).get("per_command", {})
            ft = rollout.get("finetune", {}).get("per_command", {})
            commands = continual.get("commands") or sorted(set(mh) | set(ft))
            lines += [
                "### Env rollout: does the final student still follow each command?",
                "",
                "| text command | multihead follows | finetune follows |",
                "|---|:--:|:--:|",
            ]
            for c in commands:
                mh_f = mh.get(c, {}).get("follows_goal") if isinstance(mh.get(c), dict) else None
                ft_f = ft.get(c, {}).get("follows_goal") if isinstance(ft.get(c), dict) else None
                lines.append(f"| {c} | {_check(mh_f)} | {_check(ft_f)} |")
            mh_n = rollout.get("multihead", {}).get("n_followed", "?")
            ft_n = rollout.get("finetune", {}).get("n_followed", "?")
            n_cmd = len(commands)
            lines += [
                "",
                f"multihead followed **{mh_n}/{n_cmd}**; finetune followed "
                f"**{ft_n}/{n_cmd}** (finetune typically only follows the LAST-learned "
                "command).",
                "",
            ]
    else:
        lines += [
            "_Continual skills (`continual_skills.json`) not found — "
            "multihead-vs-finetune comparison pending._",
            "",
        ]

    # --- joint_reach retention tournament ---
    lines += ["### joint_reach retention tournament", ""]
    if tournament_exists:
        lines += [
            f"See [`{tournament_rel}`]({tournament_rel}).",
            "",
            "Headline: on the toy `joint_reach` continual benchmark, per-task heads "
            "over a frozen trunk (`cbp_frozen`) reach **ACC 36.46 / Forgetting 0.00**, "
            "beating PPO (ACC 28.48) and the linear lookup (ACC 30.44); the plastic "
            "shared-trunk `cbp_multihead` reaches the highest capacity (ACC 38.94) "
            "with modest forgetting (5.67). Suggestive, not conclusive (2 seeds, toy env).",
            "",
        ]
    else:
        lines += ["_Retention tournament report not found._", ""]

    # --- retention v2 ablation (5-task / 3-seed) ---
    lines += ["### Retention v2 ablation (5-task / 3-seed)", ""]
    rows = _retention_v2_rows(retention_v2)
    if rows is not None:
        if rows:
            lines += [
                "| variant | ACC ↑ | BWT ↑ | Forgetting ↓ |",
                "|---|---:|---:|---:|",
            ]
            for name, acc, bwt, forg in rows:
                lines.append(f"| `{name}` | {_num(acc)} | {_num(bwt)} | {_num(forg)} |")
            lines.append("")
        else:
            lines += [
                "_`SUMMARY.json` present but no per-variant rows were recognized._",
                "",
            ]
    else:
        lines += [
            "_Retention v2 ablation (`alberta_retention_v2/SUMMARY.json`) not found — "
            "5-task/3-seed run pending._",
            "",
        ]
    return lines


def _retention_v2_rows(summary):
    """Best-effort extraction of (variant, acc, bwt, forgetting) rows.

    Returns None if the source is absent, [] if present but unrecognized,
    otherwise the list of rows. Tolerant of several plausible shapes since the
    producing script is not yet committed.
    """
    if summary is None:
        return None

    def row_from(name, d):
        if not isinstance(d, dict):
            return None
        keys = {k.lower(): k for k in d}
        acc = d.get(keys.get("acc"))
        bwt = d.get(keys.get("bwt"))
        forg = d.get(keys.get("forgetting", keys.get("forget", "")))
        if acc is None and bwt is None and forg is None:
            return None
        return (name, acc, bwt, forg)

    rows = []
    # Shape A: {"results"/"variants"/"learners": [{"name"/"variant"/"learner": ..., "acc": ...}]}
    for container_key in ("results", "variants", "learners", "summary"):
        container = summary.get(container_key) if isinstance(summary, dict) else None
        if isinstance(container, list):
            for item in container:
                if not isinstance(item, dict):
                    continue
                name = (
                    item.get("variant")
                    or item.get("name")
                    or item.get("learner")
                    or item.get("mechanism")
                    or "?"
                )
                r = row_from(str(name), item)
                if r:
                    rows.append(r)
            if rows:
                return rows
        # Shape B: {container: {variant_name: {"acc": ...}}}
        if isinstance(container, dict):
            for name, d in container.items():
                r = row_from(str(name), d)
                if r:
                    rows.append(r)
            if rows:
                return rows

    # Shape C: top-level {variant_name: {"acc": ...}}
    if isinstance(summary, dict):
        for name, d in summary.items():
            r = row_from(str(name), d)
            if r:
                rows.append(r)
    return rows


def section_reward(reward_exists, reward_rel) -> list[str]:
    lines = ["## 5. Reward correctness", ""]
    if reward_exists:
        lines += [
            f"See [`{reward_rel}`]({reward_rel}).",
            "",
            "The prior hand-rolled env paid an alive/upright bonus that dominated "
            "forward progress, so the optimal policy was to stand still (untrained "
            "control out-scored both learners). `train_biped_walk.py` instead uses "
            "the MuJoCo Playground joystick reward: dense velocity-command tracking "
            "plus a small alive bonus, energy cost, and early termination on a fall — "
            "so the gradient points toward locomotion, not toward quiet standing.",
            "",
        ]
    else:
        lines += ["_Reward design writeup (`REWARD_AND_APPROACH.md`) not found._", ""]
    return lines


def section_status(found: dict[str, bool], paths: dict[str, str]) -> list[str]:
    lines = [
        "## 6. Status — verified vs pending",
        "",
        "Evidence files present at generation time:",
        "",
        "| evidence source | path | found |",
        "|---|---|:--:|",
    ]
    for label, key in [
        ("PPO training reward (metrics.json)", "metrics"),
        ("Walk eval (walk_eval.json)", "walk_eval"),
        ("Continual skills (continual_skills.json)", "continual"),
        ("Retention tournament (TOURNAMENT_REPORT.md)", "tournament"),
        ("Retention v2 ablation (SUMMARY.json)", "retention_v2"),
        ("Reward writeup (REWARD_AND_APPROACH.md)", "reward"),
    ]:
        lines.append(
            f"| {label} | `{paths[key]}` | {'yes' if found[key] else 'no'} |"
        )
    n_found = sum(found.values())
    lines += [
        "",
        f"**{n_found}/{len(found)} sources present.** Sections backed by a missing "
        "source are explicitly marked pending above rather than fabricated.",
        "",
    ]
    return lines


def build_report(base: Path) -> str:
    paths = {
        "metrics": base / REL_METRICS,
        "walk_eval": base / REL_WALK_EVAL,
        "continual": base / REL_CONTINUAL,
        "tournament": base / REL_TOURNAMENT,
        "retention_v2": base / REL_RETENTION_V2,
        "reward": base / REL_REWARD,
    }
    metrics = _load_json(paths["metrics"])
    walk_eval = _load_json(paths["walk_eval"])
    continual = _load_json(paths["continual"])
    retention_v2 = _load_json(paths["retention_v2"])
    tournament_exists = paths["tournament"].is_file()
    reward_exists = paths["reward"].is_file()

    found = {
        "metrics": metrics is not None,
        "walk_eval": walk_eval is not None,
        "continual": continual is not None,
        "tournament": tournament_exists,
        "retention_v2": retention_v2 is not None,
        "reward": reward_exists,
    }
    rel_paths = {k: _rel(v, base) for k, v in paths.items()}

    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        "# Bipedal walking + continual learning + text conditioning — master report",
        "",
        f"_Generated {now}. Base: `{base}`._",
        "",
        "## 1. Claim",
        "",
        "An actual bipedal walking agent — a brax PPO policy trained on the MuJoCo "
        "Playground joystick locomotion env — that is **text-conditioned**: free text "
        "is resolved to a joystick command `[vx, vy, yaw]`, and the single trained "
        "policy follows whichever goal that command encodes. On top of the walking "
        "trunk, **Alberta continual learning** lets the agent acquire text-commanded "
        "skills sequentially: per-command heads over a consolidated trunk (`multihead`) "
        "retain earlier skills, whereas a single shared head (`finetune`) forgets them. "
        "Each section below is backed by an evidence file; sections whose source is "
        "not yet present are marked pending (see Status).",
        "",
    ]
    lines += section_walks(metrics, walk_eval)
    lines += section_text_conditioning(walk_eval, continual)
    lines += section_continual(
        continual, tournament_exists, rel_paths["tournament"], retention_v2
    )
    lines += section_reward(reward_exists, rel_paths["reward"])
    lines += section_status(found, rel_paths)
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    repo_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        type=Path,
        default=repo_root / "packages/robot",
        help="Base dir for evidence/checkpoint paths (default: packages/robot).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help=f"Output path (default: <base>/{DEFAULT_OUT}).",
    )
    args = parser.parse_args(argv)

    base = args.base.resolve()
    out = args.out.resolve() if args.out is not None else base / DEFAULT_OUT

    report = build_report(base)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
