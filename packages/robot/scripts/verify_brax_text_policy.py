"""Sanity-check a trained text-conditioned Brax PPO policy.

Loads checkpoints/text_conditioned_brax_v1/ via the existing
`TextConditionedPolicy` wrapper, runs deterministic inference on a few
canned (text, proprio) inputs, and reports action magnitudes + latency.

Run with:

    PATH="$PWD/.venv/lib/python3.11/site-packages/torch/bin:$PATH" \
        .venv/bin/python -m scripts.verify_brax_text_policy \
        --ckpt checkpoints/text_conditioned_brax_v1
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy

CANNED_TEXTS = [
    "stand up",
    "walk forward",
    "walk backward",
    "turn left",
    "turn right",
]


def _make_proprio(rng: np.random.Generator, dim: int) -> np.ndarray:
    """Synthesise a plausible proprio vector around the home pose."""
    return rng.normal(scale=0.05, size=(dim,)).astype(np.float32)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ckpt",
        type=Path,
        default=Path("checkpoints/text_conditioned_brax_v1"),
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--n-trials", type=int, default=4)
    parser.add_argument("--profile", default=None)
    parser.add_argument("--require-proprio-dim", type=int, default=None)
    parser.add_argument("--require-action-dim", type=int, default=None)
    parser.add_argument("--require-output-dim", type=int, default=None)
    args = parser.parse_args()

    print(f"Loading policy from {args.ckpt}...")
    policy = TextConditionedPolicy(args.ckpt)
    manifest = policy.manifest
    print(
        f"  regime={manifest.regime} obs_dim={manifest.obs_dim} "
        f"action_dim={manifest.action_dim}"
    )
    print(f"  active_tasks={manifest.active_tasks}")
    print(
        f"  hidden_layers={manifest.policy_hidden_layer_sizes} "
        f"normalize_obs={manifest.normalize_observations}"
    )

    rng = np.random.default_rng(args.seed)
    # Proprio width = obs_dim - text_dim. The manifest can carry that
    # directly; if not, infer from the cached embedding.
    raw = json.loads((args.ckpt / "manifest.json").read_text())
    proprio_dim = int(raw.get("proprio_dim", manifest.obs_dim - 384))
    text_dim = int(raw.get("text_dim", manifest.obs_dim - proprio_dim))
    print(f"  proprio_dim={proprio_dim} text_dim={text_dim}")
    print()

    # First call warms JIT. Don't include it in latency stats.
    print("Warmup pass...")
    t0 = time.time()
    action, task_id = policy.act(CANNED_TEXTS[0], _make_proprio(rng, proprio_dim))
    print(
        f"  warmup task={task_id} action_shape={action.shape} "
        f"elapsed={(time.time()-t0)*1000:.1f}ms"
    )
    print()

    results = []
    for text in CANNED_TEXTS:
        magnitudes: list[float] = []
        latencies_ms: list[float] = []
        actions_first: np.ndarray | None = None
        for _trial in range(args.n_trials):
            proprio = _make_proprio(rng, proprio_dim)
            t0 = time.time()
            action, task_id = policy.act(text, proprio)
            latencies_ms.append((time.time() - t0) * 1000)
            magnitudes.append(float(np.linalg.norm(action)))
            if actions_first is None:
                actions_first = action
        print(
            f"[{text:<14}] task={task_id:<14} "
            f"|a|={np.mean(magnitudes):.3f}±{np.std(magnitudes):.3f} "
            f"latency={np.mean(latencies_ms):.2f}ms ± {np.std(latencies_ms):.2f}ms"
        )
        if actions_first is not None:
            head = ", ".join(f"{v:+.3f}" for v in actions_first[:6])
            tail = ", ".join(f"{v:+.3f}" for v in actions_first[-6:])
            print(f"   first action sample (head/tail): [{head}] ... [{tail}]")
        results.append(
            {
                "text": text,
                "task_id": task_id,
                "action_magnitude_mean": float(np.mean(magnitudes)),
                "action_magnitude_std": float(np.std(magnitudes)),
                "latency_ms_mean": float(np.mean(latencies_ms)),
                "latency_ms_std": float(np.std(latencies_ms)),
                "first_action": actions_first.tolist() if actions_first is not None else [],
            }
        )

    out_path = args.ckpt / "inference_check.json"
    output_dim = int(raw.get("output_dim", manifest.output_dim))
    checks = {
        "profile": args.profile is None or manifest.profile_id == args.profile,
        "proprio_dim": args.require_proprio_dim is None or proprio_dim == args.require_proprio_dim,
        "action_dim": args.require_action_dim is None or manifest.action_dim == args.require_action_dim,
        "output_dim": args.require_output_dim is None or output_dim == args.require_output_dim,
    }
    report = {"ok": all(checks.values()), "checks": checks, "results": results}
    out_path.write_text(json.dumps(report, indent=2))
    print()
    print(f"Wrote {out_path}")
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
