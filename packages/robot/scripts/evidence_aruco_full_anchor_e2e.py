"""Fused sim2real anchor evidence — joints (StateMirror) + torso (ArUco).

What this script proves:

  Real robot's joints  ── StateMirrorBackend ──► sim.qpos[joint slots]
  Real robot's torso   ── Obsbot + ArUco     ──► sim.qpos[0:7] (free joint)

  Result: every component of sim's qpos that is observable on the real
  robot is locked to the real measurement. The only remaining drift is
  encoder/PnP noise + the period between updates.

Outputs (`--out`, default `examples/robot-mujoco-demo/evidence/aruco_full_anchor/`):

  - obsbot_live.mp4            raw Obsbot stream with ArUco overlays
  - sim_external.mp4           MuJoCo external camera (now anchored to real)
  - side_by_side.mp4           obsbot ⟷ sim panels with HUD per frame
  - per_tick.jsonl             every fused divergence record
  - report.json                aggregate stats + run metadata
  - probe_annotated.png        sample Obsbot frame with detections
  - README.md                  written separately

Source-mode selection (auto):

  - `--obsbot N` enumerates `/dev/videoN`. If it opens, we use it.
    Otherwise the script falls back to **synthetic** mode: every sim
    external frame has the ground origin (id 2) and the robot body
    (id 0) composited at known pixel locations and that synthetic
    frame drives the ArUco anchor. The pose math is identical; only
    the pixel source changes.
  - `--no-real` skips the real-robot connection entirely; joint
    divergence is reported as `n=0`, only the torso anchor runs.

Walking commands are deliberately *not* sent to the real robot — only
the head + scripted gestures (`stand still`, `wave hello`).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.aruco_detector import ArucoDetector
from eliza_robot.sim.mujoco.demo_env import DemoEnv
from eliza_robot.sim2real.aruco_anchor import (
    FusedSim2RealAnchor,
    FusedAnchorStats,
)


# ----------------------------------------------------------------------
# Obsbot capture (optional)
# ----------------------------------------------------------------------


def _try_open_obsbot(device: int, width: int, height: int) -> cv2.VideoCapture | None:
    cap = cv2.VideoCapture(device, cv2.CAP_V4L2)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, 30)
    if not cap.isOpened():
        cap.release()
        return None
    # Warm-up
    for _ in range(10):
        cap.read()
    ok, _ = cap.read()
    if not ok:
        cap.release()
        return None
    return cap


def _obsbot_intrinsics(width: int, height: int) -> CameraIntrinsics:
    """Approximate Obsbot Tiny SE intrinsics — HFOV ~86 deg at 1080p."""
    fx = width / (2.0 * math.tan(math.radians(43.0)))
    return CameraIntrinsics(
        fx=fx, fy=fx, cx=width / 2.0, cy=height / 2.0,
        width=width, height=height,
    )


# ----------------------------------------------------------------------
# Synthetic ArUco compositing (fallback when no Obsbot)
# ----------------------------------------------------------------------


def _composite_aruco(
    base: np.ndarray, marker_id: int, size_px: int, top_left: tuple[int, int]
) -> np.ndarray:
    """Paste a fronto-parallel ArUco marker into `base` (BGR or RGB uint8)."""
    dict_ = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_6X6_250)
    marker = np.zeros((size_px, size_px), dtype=np.uint8)
    cv2.aruco.generateImageMarker(dict_, marker_id, size_px, marker, 1)
    pad = max(20, size_px // 6)
    bordered = np.full(
        (size_px + 2 * pad, size_px + 2 * pad), 255, dtype=np.uint8
    )
    bordered[pad : pad + size_px, pad : pad + size_px] = marker
    h, w = bordered.shape
    y, x = top_left
    out = base.copy()
    # Clamp paste to image bounds.
    y2 = min(y + h, out.shape[0])
    x2 = min(x + w, out.shape[1])
    out[y:y2, x:x2] = np.stack([bordered[: y2 - y, : x2 - x]] * 3, axis=-1)
    return out


def _build_synthetic_frame(
    sim_env: DemoEnv,
    width: int,
    height: int,
    body_id: int,
    origin_id: int,
) -> np.ndarray:
    """Render sim external view and composite ground origin + body markers.

    Returns BGR uint8 (compatible with cv2.VideoWriter).
    """
    rgb = sim_env.render_external(width=width, height=height)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    # Origin marker (id=2) bottom-left of frame so it represents the floor.
    bgr = _composite_aruco(
        bgr, marker_id=origin_id, size_px=140,
        top_left=(int(height * 0.55), int(width * 0.10)),
    )
    # Body marker (id=0) centered on robot, slightly above origin in pixels.
    bgr = _composite_aruco(
        bgr, marker_id=body_id, size_px=110,
        top_left=(int(height * 0.30), int(width * 0.42)),
    )
    return bgr


# ----------------------------------------------------------------------
# Real-robot wiring (optional)
# ----------------------------------------------------------------------


async def _try_connect_real(host: str, port: int) -> Any | None:
    """Connect to AinexRemoteBackend; return None if anything fails.

    Failures here are non-fatal — the script runs in sim-only mode.
    """
    try:
        from eliza_robot.bridge.backends.ainex_remote import AinexRemoteBackend
    except Exception as exc:  # noqa: BLE001 — informational
        print(f"[fused-anchor] AinexRemoteBackend import failed: {exc}")
        return None
    try:
        real = AinexRemoteBackend(host=host, port=port)
        await asyncio.wait_for(real.connect(), timeout=5.0)
    except Exception as exc:  # noqa: BLE001 — informational
        print(f"[fused-anchor] real-robot connect failed ({host}:{port}): {exc}")
        return None
    return real


async def _start_state_mirror(
    real: Any,
    sim_env: DemoEnv,
    *,
    sync_period_s: float,
) -> Any | None:
    """Wrap MuJoCo + real in DualTarget, then StateMirror. Return the
    StateMirrorBackend (already connected). None on failure.
    """
    try:
        from eliza_robot.bridge.backends.dual_target import DualTargetBackend
        from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
        from eliza_robot.bridge.backends.state_mirror import StateMirrorBackend
    except Exception as exc:  # noqa: BLE001 — informational
        print(f"[fused-anchor] mirror import failed: {exc}")
        return None
    try:
        sim = MuJocoBackend(sim_env, profile_id="hiwonder-ainex")
        dual = DualTargetBackend(real=real, sim=sim)
        mirror = StateMirrorBackend(
            dual, real=real, sim_env=sim_env, sync_period_s=sync_period_s,
        )
        await mirror.connect()
    except Exception as exc:  # noqa: BLE001 — informational
        print(f"[fused-anchor] mirror start failed: {exc}")
        return None
    return mirror


# ----------------------------------------------------------------------
# Frame drawing helpers
# ----------------------------------------------------------------------


def _annotate_external(
    frame: np.ndarray,
    detections: list,
    intrinsics: CameraIntrinsics,
) -> np.ndarray:
    """Overlay detected markers + pose axes onto a BGR uint8 frame."""
    if not detections:
        return frame
    out = frame.copy()
    for d in detections:
        cv2.aruco.drawDetectedMarkers(
            out, [d.corners.reshape(1, 4, 2)], np.array([[d.marker_id]])
        )
        cv2.drawFrameAxes(
            out, intrinsics.camera_matrix, intrinsics.dist_array,
            d.rvec, d.tvec, 0.04,
        )
        cx, cy = d.corners.mean(axis=0).astype(int)
        cv2.putText(
            out, f"id={d.marker_id} d={d.distance:.2f}m",
            (int(cx - 70), int(cy - 12)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2,
        )
    return out


def _draw_hud(
    frame: np.ndarray,
    *,
    title: str,
    stats: FusedAnchorStats | None,
    mode_label: str,
    prompt: str,
) -> np.ndarray:
    """Draw a bottom HUD strip with the per-tick divergence."""
    h, w = frame.shape[:2]
    out = frame.copy()
    bar_h = 78
    overlay = out.copy()
    cv2.rectangle(overlay, (0, h - bar_h), (w, h), (0, 0, 0), -1)
    out = cv2.addWeighted(overlay, 0.55, out, 0.45, 0)
    cv2.putText(
        out, f"{title}  [{mode_label}]  prompt={prompt!r}",
        (14, h - bar_h + 22),
        cv2.FONT_HERSHEY_SIMPLEX, 0.62, (240, 240, 240), 2,
    )
    if stats is not None:
        line = (
            f"joints RMS={stats.joint_rms_mrad:6.1f} mrad (n={stats.joint_n}) | "
            f"torso d_xy={stats.torso_dxy_m * 100:5.1f} cm "
            f"d_yaw={stats.torso_dyaw_deg:5.1f} deg | "
            f"aruco_lock={'Y' if stats.aruco_pose_locked else 'N'} "
            f"ids={stats.aruco_ids_seen}"
        )
        cv2.putText(
            out, line, (14, h - bar_h + 50),
            cv2.FONT_HERSHEY_SIMPLEX, 0.50, (180, 240, 180), 1,
        )
        cv2.putText(
            out, f"t = {stats.t_s:6.2f}s", (14, h - 12),
            cv2.FONT_HERSHEY_SIMPLEX, 0.50, (200, 200, 200), 1,
        )
    return out


# ----------------------------------------------------------------------
# Main run
# ----------------------------------------------------------------------


async def _run(args: argparse.Namespace) -> int:
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    # ----- Sim env (always present) --------------------------------------
    sim_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    sim_env.reset()
    print(f"[fused-anchor] sim env initialized "
          f"({sim_env.model.nq} qpos, {sim_env.model.nu} actuators)")

    # ----- Obsbot probe --------------------------------------------------
    cap = None
    obsbot_label = "obsbot-missing"
    obsbot_w = obsbot_h = 0
    if not args.synthetic_only:
        cap = _try_open_obsbot(args.obsbot, args.width, args.height)
        if cap is not None:
            obsbot_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            obsbot_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            obsbot_label = f"obsbot:/dev/video{args.obsbot}@{obsbot_w}x{obsbot_h}"
            print(f"[fused-anchor] {obsbot_label}")
        else:
            print(f"[fused-anchor] /dev/video{args.obsbot} unavailable; "
                  "falling back to synthetic ArUco compositing")
    else:
        print("[fused-anchor] --synthetic-only set; skipping Obsbot probe")

    synthetic_mode = cap is None
    if synthetic_mode:
        obsbot_w = args.synth_width
        obsbot_h = args.synth_height
        intrinsics = CameraIntrinsics(
            fx=obsbot_w * 1.0, fy=obsbot_w * 1.0,
            cx=obsbot_w / 2.0, cy=obsbot_h / 2.0,
            width=obsbot_w, height=obsbot_h,
        )
    else:
        intrinsics = _obsbot_intrinsics(obsbot_w, obsbot_h)

    detector = ArucoDetector(intrinsics, marker_size_m=args.marker_size_m)
    anchor = FusedSim2RealAnchor(
        sim_env, intrinsics, detector=detector,
        body_marker_id=args.body_marker_id,
        ground_origin_id=args.ground_origin_id,
        marker_size_m=args.marker_size_m,
    )

    # ----- Real robot + StateMirror (optional) ---------------------------
    real = None
    mirror = None
    mirror_label = "mirror-off"
    if not args.no_real:
        real = await _try_connect_real(args.host, args.port)
        if real is not None:
            mirror = await _start_state_mirror(
                real, sim_env, sync_period_s=args.mirror_period,
            )
            if mirror is not None:
                mirror_label = (
                    f"mirror-on@{int(args.mirror_period * 1000)}ms"
                )
                # Let StateMirror catch up before the run starts.
                await asyncio.sleep(1.0)

    mode_label = f"{obsbot_label} | {mirror_label}"
    print(f"[fused-anchor] mode: {mode_label}")

    # ----- Writers -------------------------------------------------------
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    sim_w, sim_h = args.sim_width, args.sim_height
    sim_writer = cv2.VideoWriter(
        str(out / "sim_external.mp4"), fourcc, args.fps, (sim_w, sim_h),
    )
    obsbot_writer = cv2.VideoWriter(
        str(out / "obsbot_live.mp4"), fourcc, args.fps, (obsbot_w, obsbot_h),
    )
    sxs_w, sxs_h = sim_w + obsbot_w, max(sim_h, obsbot_h)
    sxs_writer = cv2.VideoWriter(
        str(out / "side_by_side.mp4"), fourcc, args.fps, (sxs_w, sxs_h),
    )
    per_tick_path = out / "per_tick.jsonl"
    per_tick_fh = per_tick_path.open("w")

    sample_obsbot_saved = False
    aggregate: list[FusedAnchorStats] = []
    prompts = [p.strip() for p in args.prompts.split(",") if p.strip()]
    per_prompt_summary: list[dict] = []
    frame_period = 1.0 / args.fps
    t_start = time.time()

    try:
        for prompt in prompts:
            print(f"[fused-anchor] >>> prompt={prompt!r}")
            # We deliberately send only safe gestures. No walk commands.
            await _send_safe_gesture(mirror, prompt)
            t0 = time.time()
            t_end = t0 + args.episode_s
            while time.time() < t_end:
                t_loop = time.time() - t_start

                # 1. Source frame for the ArUco anchor.
                if synthetic_mode:
                    frame_bgr = _build_synthetic_frame(
                        sim_env, obsbot_w, obsbot_h,
                        body_id=args.body_marker_id,
                        origin_id=args.ground_origin_id,
                    )
                else:
                    ok, frame_bgr = cap.read()
                    if not ok or frame_bgr is None:
                        # Lost the camera mid-run — fall back to synthetic.
                        print("[fused-anchor] Obsbot dropped a frame; "
                              "compositing synthetic frame for this tick")
                        frame_bgr = _build_synthetic_frame(
                            sim_env, obsbot_w, obsbot_h,
                            body_id=args.body_marker_id,
                            origin_id=args.ground_origin_id,
                        )

                # 2. Run anchor + record detections seen.
                detections = detector.detect(frame_bgr)
                ids_seen = sorted(int(d.marker_id) for d in detections)
                pose = anchor.anchor_from_frame(frame_bgr)
                if pose is None and synthetic_mode:
                    # If composite anchor fails (shouldn't), surface it loud.
                    print("[fused-anchor] WARNING: synthetic anchor returned None "
                          f"(ids_seen={ids_seen})")

                # 3. Sample real joints (StateMirror is also reading them,
                #    independently — this is just for the divergence record).
                real_joints: dict[str, float] = {}
                if real is not None:
                    try:
                        real_joints = await asyncio.wait_for(
                            real.read_joint_positions(), timeout=0.3,
                        )
                    except Exception:
                        real_joints = {}

                # 4. Per-tick stats.
                stats = anchor.divergence(
                    t_s=t_loop,
                    real_joint_positions=real_joints or None,
                    aruco_ids_seen=ids_seen,
                )
                aggregate.append(stats)
                per_tick_fh.write(json.dumps({
                    **stats.to_json(),
                    "prompt": prompt,
                    "obsbot": not synthetic_mode,
                }) + "\n")

                # 5. Save the first detection-bearing Obsbot frame as a probe.
                if not sample_obsbot_saved and detections:
                    annot = _annotate_external(frame_bgr, detections, intrinsics)
                    cv2.imwrite(str(out / "probe_annotated.png"), annot)
                    sample_obsbot_saved = True

                # 6. Write the three videos.
                annot = _annotate_external(frame_bgr, detections, intrinsics)
                annot_hud = _draw_hud(
                    annot, title="Obsbot/synthetic",
                    stats=stats, mode_label=obsbot_label, prompt=prompt,
                )
                obsbot_writer.write(annot_hud)

                sim_rgb = sim_env.render_external(width=sim_w, height=sim_h)
                sim_bgr = cv2.cvtColor(sim_rgb, cv2.COLOR_RGB2BGR)
                sim_hud = _draw_hud(
                    sim_bgr, title="MuJoCo external (anchored)",
                    stats=stats, mode_label=mirror_label, prompt=prompt,
                )
                sim_writer.write(sim_hud)

                # Side-by-side: pad shorter panel to common height.
                left = annot_hud
                right = sim_hud
                if left.shape[0] != sxs_h:
                    pad = np.zeros(
                        (sxs_h - left.shape[0], left.shape[1], 3), dtype=np.uint8,
                    )
                    left = np.vstack([left, pad])
                if right.shape[0] != sxs_h:
                    pad = np.zeros(
                        (sxs_h - right.shape[0], right.shape[1], 3),
                        dtype=np.uint8,
                    )
                    right = np.vstack([right, pad])
                sxs = np.hstack([left, right])
                sxs_writer.write(sxs)

                # 7. Pace.
                await asyncio.sleep(max(0.0, frame_period - 0.005))

            per_prompt_summary.append({
                "prompt": prompt,
                "duration_s": round(time.time() - t0, 2),
                "ticks": sum(1 for s in aggregate if abs(s.t_s - t_loop) < args.episode_s),
            })
    finally:
        per_tick_fh.close()
        sim_writer.release()
        obsbot_writer.release()
        sxs_writer.release()
        if cap is not None:
            cap.release()
        if mirror is not None:
            try:
                await mirror.shutdown()
            except Exception:
                pass
        if real is not None and mirror is None:
            try:
                await real.shutdown()
            except Exception:
                pass

    # ----- Aggregate report ---------------------------------------------
    joint_rms = [s.joint_rms_mrad for s in aggregate if s.joint_n > 0]
    torso_dxy = [s.torso_dxy_m for s in aggregate if s.aruco_pose_locked]
    torso_dyaw = [
        abs(s.torso_dyaw_deg) for s in aggregate if s.aruco_pose_locked
    ]
    torso_pre_dxy = [
        s.torso_pre_dxy_m for s in aggregate if s.aruco_pose_locked
    ]
    torso_pre_dyaw = [
        abs(s.torso_pre_dyaw_deg) for s in aggregate if s.aruco_pose_locked
    ]
    all_ids: set[int] = set()
    for s in aggregate:
        all_ids.update(s.aruco_ids_seen)

    def _agg(xs: list[float]) -> dict | None:
        if not xs:
            return None
        return {
            "n": len(xs),
            "mean": float(np.mean(xs)),
            "median": float(np.median(xs)),
            "p95": float(np.percentile(xs, 95)),
            "max": float(max(xs)),
        }

    report = {
        "obsbot": {
            "available": not synthetic_mode,
            "device": (
                f"/dev/video{args.obsbot}" if not synthetic_mode else None
            ),
            "resolution": [obsbot_w, obsbot_h],
            "intrinsics": {
                "fx": intrinsics.fx, "fy": intrinsics.fy,
                "cx": intrinsics.cx, "cy": intrinsics.cy,
                "hfov_deg": intrinsics.hfov_deg,
            },
        },
        "real_robot": {
            "host": f"{args.host}:{args.port}",
            "connected": real is not None,
            "state_mirror_active": mirror is not None,
            "mirror_period_s": args.mirror_period if mirror is not None else None,
            "stats": (
                {
                    "syncs_completed": int(mirror.stats.syncs_completed),
                    "last_n_joints_synced": int(mirror.stats.last_n_joints_synced),
                    "last_sync_rms_mrad": float(mirror.stats.last_sync_rms_mrad),
                }
                if mirror is not None else None
            ),
        },
        "aruco": {
            "body_marker_id": args.body_marker_id,
            "ground_origin_id": args.ground_origin_id,
            "marker_size_m": args.marker_size_m,
            "unique_ids_seen": sorted(all_ids),
        },
        "joint_divergence_mrad": _agg(joint_rms),
        "torso_residual_cm_post_anchor": (
            _agg([d * 100.0 for d in torso_dxy]) if torso_dxy else None
        ),
        "torso_residual_yaw_deg_post_anchor": _agg(torso_dyaw),
        "torso_drift_cm_pre_anchor": (
            _agg([d * 100.0 for d in torso_pre_dxy]) if torso_pre_dxy else None
        ),
        "torso_drift_yaw_deg_pre_anchor": _agg(torso_pre_dyaw),
        "prompts": per_prompt_summary,
        "ticks_total": len(aggregate),
        "fps_target": args.fps,
        "mode_label": mode_label,
    }
    (out / "report.json").write_text(json.dumps(report, indent=2))

    # ----- Short stdout summary -----------------------------------------
    print(f"[fused-anchor] wrote {out / 'report.json'}")
    if report["joint_divergence_mrad"]:
        j = report["joint_divergence_mrad"]
        print(f"[fused-anchor] joints  RMS    mean={j['mean']:.1f} mrad  "
              f"p95={j['p95']:.1f}  max={j['max']:.1f}")
    if report["torso_drift_cm_pre_anchor"]:
        t = report["torso_drift_cm_pre_anchor"]
        print(f"[fused-anchor] torso  pre-anchor dxy  mean={t['mean']:.2f} cm  "
              f"p95={t['p95']:.2f}  max={t['max']:.2f}")
    if report["torso_residual_cm_post_anchor"]:
        t = report["torso_residual_cm_post_anchor"]
        print(f"[fused-anchor] torso  post-anchor residual dxy  "
              f"mean={t['mean']:.4f} cm  max={t['max']:.4f}")
    if report["torso_drift_yaw_deg_pre_anchor"]:
        y = report["torso_drift_yaw_deg_pre_anchor"]
        print(f"[fused-anchor] torso  pre-anchor dyaw mean={y['mean']:.2f} deg  "
              f"p95={y['p95']:.2f}  max={y['max']:.2f}")
    return 0


async def _send_safe_gesture(mirror: Any | None, prompt: str) -> None:
    """Send only head/wave gestures. Never a walk command.

    If mirror is None, no-op (sim-only mode — sim's qpos will be moved
    by the FusedAnchor's free-joint write each tick, but joints stay at
    the default standing pose).
    """
    if mirror is None:
        return
    from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso

    SAFE: dict[str, dict] = {
        "stand still": {"command": "action.play", "payload": {"name": "stand"}},
        "wave hello": {"command": "action.play", "payload": {"name": "wave"}},
        "look up": {
            "command": "joints.set",
            "payload": {"joint_positions": {"head_pitch": -0.4}},
        },
        "look down": {
            "command": "joints.set",
            "payload": {"joint_positions": {"head_pitch": 0.4}},
        },
    }
    spec = SAFE.get(prompt.lower())
    if spec is None:
        # Default: stand. Never forward arbitrary text — could be a walk.
        spec = SAFE["stand still"]
    try:
        await mirror.handle_command(CommandEnvelope(
            request_id=f"fused-{prompt}",
            timestamp=utc_now_iso(),
            command=spec["command"],
            payload=spec["payload"],
        ))
    except Exception as exc:  # noqa: BLE001 — informational
        print(f"[fused-anchor] gesture {prompt!r} dispatch failed: {exc}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--obsbot", type=int, default=4,
                        help="v4l2 device index for the Obsbot")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--synth-width", type=int, default=1280)
    parser.add_argument("--synth-height", type=int, default=720)
    parser.add_argument("--sim-width", type=int, default=1280)
    parser.add_argument("--sim-height", type=int, default=720)
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--mirror-period", type=float, default=0.05,
                        help="StateMirror sync period (s)")
    parser.add_argument("--marker-size-m", type=float, default=0.0508,
                        help="ArUco square side, meters (2 inches default)")
    parser.add_argument("--body-marker-id", type=int, default=0)
    parser.add_argument("--ground-origin-id", type=int, default=2)
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--prompts", default="stand still,wave hello",
                        help="comma-separated; only safe gestures honored")
    parser.add_argument("--episode-s", type=float, default=7.5,
                        help="seconds per prompt (default ~15s for two prompts)")
    parser.add_argument("--no-real", action="store_true",
                        help="skip real-robot connect entirely")
    parser.add_argument("--synthetic-only", action="store_true",
                        help="skip Obsbot probe entirely; always composite")
    parser.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parents[1] / "examples"
        / "robot-mujoco-demo" / "evidence" / "aruco_full_anchor",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
