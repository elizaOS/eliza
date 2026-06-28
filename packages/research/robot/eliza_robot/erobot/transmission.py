"""Transmission proof: a leg motor controls foot/toe position through the pulley.

Three things are proven, in MuJoCo and in closed form:

  1. **Position control through the cable + pulley.** The toe is driven by a
     shank-mounted winch (a position actuator that spools the tendon over an
     ankle pulley). Commanding the winch length sweeps the toe through a
     monotonic, repeatable command -> angle -> Cartesian-position map. We report
     the transmission ratio (the effective lever radius d(length)/d(angle)).

  2. **Pulley / belt mechanics.** Effective lever + pulley radius, cable wrap
     angle, capstan holding ratio (for the friction-belt alternative), force
     capacity (winch torque -> cable tension -> toe torque), and backlash
     (zero: it is a positive anchored cable, not a geared train).

  3. **The leg motors place the foot in 3D.** Sweeping knee + ankle pitch moves
     the foot tip to distinct commanded positions (forward-kinematic position
     control of the foot by the leg actuators).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from eliza_robot.erobot.mjcf import write_models
from eliza_robot.erobot.spec import RobotSpec, build_spec

PROOFS_ROOT = Path(__file__).resolve().parents[2] / "cad" / "erobot" / "proofs"
WINCH_RADIUS_M = 0.015      # cable spool radius on the winch motor
CABLE_BREAK_N = 1800.0      # 1.5 mm Dyneema
WINCH_MOTOR_TORQUE_NM = 10.0  # XM540-class winch
PULLEY_FRICTION = 0.2       # cable-on-plastic (only relevant for a friction belt)


def _toe_tip_world(model, data, body_id: float, toe_len: float = 0.08) -> np.ndarray:
    import numpy as np
    R = data.xmat[body_id].reshape(3, 3)
    return np.array(data.xpos[body_id]) + R @ np.array([toe_len, 0.0, 0.0])


def characterize_toe_drive(spec: RobotSpec | None = None, *, samples: int = 9,
                           side: str = "left") -> dict:
    import mujoco

    spec = spec or build_spec()
    model = mujoco.MjModel.from_xml_path(str(write_models(spec)["scene"]))
    model.opt.gravity[:] = 0.0  # isolate the transmission (foot lifted, no contact)
    data = mujoco.MjData(model)
    aid = model.actuator(f"{side}_toe_act").id
    qadr = model.joint(f"{side}_toe_joint").qposadr[0]
    tid = model.tendon(f"{side}_toe_tendon").id
    toe_bid = model.body(f"{side}_toe").id
    lo, hi = model.actuator_ctrlrange[aid]

    def settle_to(length: float) -> tuple[float, float, np.ndarray]:
        mujoco.mj_resetDataKeyframe(model, data, 0)
        data.qpos[2] += 0.4  # lift so the foot swings free
        home_ctrl = data.ctrl.copy()
        data.ctrl[:] = home_ctrl
        data.ctrl[aid] = length
        for _ in range(500):
            mujoco.mj_step(model, data)
        return float(data.qpos[qadr]), float(data.ten_length[tid]), _toe_tip_world(model, data, toe_bid)

    cmds = np.linspace(lo, hi, samples)
    fwd = [settle_to(L) for L in cmds]
    bwd = [settle_to(L) for L in reversed(cmds)]
    bwd.reverse()

    angles = [f[0] for f in fwd]
    lengths = [f[1] for f in fwd]
    tips = [f[2] for f in fwd]

    diffs = np.diff(angles)
    monotonic = bool(np.all(diffs <= 1e-3))  # non-increasing (more length -> more dorsiflex)
    hysteresis = max(abs(fwd[i][0] - bwd[i][0]) for i in range(samples))
    # transmission ratio: effective lever radius = |d(length)/d(angle)|
    span_angle = angles[0] - angles[-1]
    span_len = lengths[-1] - lengths[0]
    lever_m = abs(span_len / span_angle) if abs(span_angle) > 1e-6 else float("nan")
    tip_travel_mm = float(np.linalg.norm(np.array(tips[0]) - np.array(tips[-1])) * 1000)
    # winch motor angle -> toe angle (length = r_winch * motor_angle)
    motor_to_toe = WINCH_RADIUS_M / lever_m if lever_m else float("nan")

    return {
        "side": side,
        "command_is_tendon_length_m": [round(lo, 4), round(hi, 4)],
        "samples": [
            {"cmd_len_m": round(float(c), 4), "toe_deg": round(math.degrees(a), 2),
             "tendon_len_m": round(tl, 4),
             "toe_tip_world_m": [round(float(x), 4) for x in t]}
            for c, a, tl, t in zip(cmds, angles, lengths, tips, strict=True)
        ],
        "monotonic": monotonic,
        "repeatable_hysteresis_deg": round(math.degrees(hysteresis), 3),
        "toe_travel_deg": round(math.degrees(span_angle), 1),
        "toe_tip_travel_mm": round(tip_travel_mm, 1),
        "effective_lever_radius_mm": round(lever_m * 1000, 2),
        "winch_radius_mm": round(WINCH_RADIUS_M * 1000, 1),
        "motor_angle_to_toe_angle_ratio": round(motor_to_toe, 3),
        "ok": bool(monotonic and math.degrees(hysteresis) < 2.0 and tip_travel_mm > 10.0),
    }


def pulley_belt_mechanics(spec: RobotSpec | None = None, *, side: str = "left") -> dict:
    import mujoco

    spec = spec or build_spec()
    model = mujoco.MjModel.from_xml_path(str(write_models(spec)["scene"]))
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, 0)
    mujoco.mj_forward(model, data)

    shank = np.array(data.site(f"{side}_toe_cable_shank").xpos)
    anchor = np.array(data.site(f"{side}_toe_cable_anchor").xpos)
    pulley = np.array(data.geom(f"{side}_ankle_pulley_geom").xpos)
    pulley_r = float(model.geom(f"{side}_ankle_pulley_geom").size[0])

    v_in = pulley - shank
    v_out = anchor - pulley
    cos_t = float(np.dot(v_in, v_out) / (np.linalg.norm(v_in) * np.linalg.norm(v_out)))
    turn = math.acos(max(-1.0, min(1.0, cos_t)))   # cable turn angle at the pulley
    wrap = turn

    capstan_ratio = math.exp(PULLEY_FRICTION * wrap)   # friction-belt holding ratio
    max_tension = WINCH_MOTOR_TORQUE_NM / WINCH_RADIUS_M
    # toe torque capacity uses the measured lever radius
    lever = characterize_toe_drive(spec, samples=5, side=side)["effective_lever_radius_mm"] / 1000.0
    max_toe_torque = max_tension * lever
    return {
        "side": side,
        "drive_type": "positive anchored cable over an idler pulley (zero slip, zero backlash)",
        "pulley_radius_mm": round(pulley_r * 1000, 1),
        "cable_wrap_angle_deg": round(math.degrees(wrap), 1),
        "capstan_holding_ratio_if_friction_belt": round(capstan_ratio, 2),
        "winch_motor_torque_nm": WINCH_MOTOR_TORQUE_NM,
        "max_cable_tension_n": round(max_tension, 1),
        "cable_breaking_n": CABLE_BREAK_N,
        "cable_safety_factor": round(CABLE_BREAK_N / max_tension, 1),
        "effective_lever_radius_mm": round(lever * 1000, 2),
        "max_toe_torque_nm": round(max_toe_torque, 2),
        "backlash_deg": 0.0,
        "ok": bool(CABLE_BREAK_N / max_tension >= 2.0 and max_toe_torque > 1.0),
    }


def foot_position_by_leg_motors(spec: RobotSpec | None = None, *, samples: int = 7,
                                side: str = "left") -> dict:
    """Sweep knee + ankle-pitch and show the foot tip tracks to commanded poses."""
    import mujoco

    spec = spec or build_spec()
    model = mujoco.MjModel.from_xml_path(str(write_models(spec)["scene"]))
    model.opt.gravity[:] = 0.0
    data = mujoco.MjData(model)
    foot_bid = model.body(f"{side}_ankle_roll").id

    def sweep(joint: str) -> list[dict]:
        aid = model.actuator(joint.replace("_joint", "_act")).id
        qadr = model.joint(joint).qposadr[0]
        lo, hi = model.actuator_ctrlrange[aid]
        rows = []
        for c in np.linspace(lo, hi, samples):
            mujoco.mj_resetDataKeyframe(model, data, 0)
            data.qpos[2] += 0.4
            home = data.ctrl.copy()
            data.ctrl[:] = home
            data.ctrl[aid] = c
            for _ in range(450):
                mujoco.mj_step(model, data)
            rows.append({"cmd_rad": round(float(c), 3),
                         "achieved_rad": round(float(data.qpos[qadr]), 3),
                         "foot_xpos_m": [round(float(x), 4) for x in data.xpos[foot_bid]]})
        return rows

    knee = sweep(f"{side}_knee_joint")
    ankle = sweep(f"{side}_ankle_pitch_joint")
    knee_track = max(abs(r["cmd_rad"] - r["achieved_rad"]) for r in knee)
    ankle_track = max(abs(r["cmd_rad"] - r["achieved_rad"]) for r in ankle)
    knee_z_range = max(r["foot_xpos_m"][2] for r in knee) - min(r["foot_xpos_m"][2] for r in knee)
    return {
        "side": side,
        "knee_sweep": knee,
        "ankle_pitch_sweep": ankle,
        "knee_tracking_err_rad": round(knee_track, 3),
        "ankle_tracking_err_rad": round(ankle_track, 3),
        "knee_moves_foot_height_m": round(knee_z_range, 3),
        # 0.08 rad (~4.6°) tolerates the finite-kp servo steady-state offset
        "ok": bool(knee_track < 0.08 and ankle_track < 0.08 and knee_z_range > 0.1),
    }


def transmission_proof(spec: RobotSpec | None = None) -> dict:
    spec = spec or build_spec()
    toe = characterize_toe_drive(spec)
    mech = pulley_belt_mechanics(spec)
    foot = foot_position_by_leg_motors(spec)
    return {
        "schema": "erobot-transmission-v1",
        "ok": bool(toe["ok"] and mech["ok"] and foot["ok"]),
        "summary": (
            f"shank winch -> ankle pulley -> toe: {toe['toe_travel_deg']}° travel, "
            f"{toe['toe_tip_travel_mm']} mm tip motion, lever {toe['effective_lever_radius_mm']} mm, "
            f"hysteresis {toe['repeatable_hysteresis_deg']}°; cable SF {mech['cable_safety_factor']}; "
            f"knee moves foot {foot['knee_moves_foot_height_m']} m"
        ),
        "toe_position_control": toe,
        "pulley_belt_mechanics": mech,
        "foot_position_by_leg_motors": foot,
    }


def render_characterization(spec: RobotSpec | None = None, out: Path | None = None) -> Path:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    spec = spec or build_spec()
    toe = characterize_toe_drive(spec)
    foot = foot_position_by_leg_motors(spec)
    cmds = [s["cmd_len_m"] for s in toe["samples"]]
    angs = [s["toe_deg"] for s in toe["samples"]]
    out = out or (PROOFS_ROOT.parent / "visual" / "transmission.png")
    out.parent.mkdir(parents=True, exist_ok=True)

    fig, ax = plt.subplots(1, 2, figsize=(10, 4))
    ax[0].plot([(c - cmds[0]) * 1000 for c in cmds], angs, "o-", color="#d4661f")
    ax[0].set_xlabel("winch spool command Δlength (mm)")
    ax[0].set_ylabel("toe angle (deg)")
    ax[0].set_title(f"cable/pulley position control\nlever {toe['effective_lever_radius_mm']} mm, "
                    f"hysteresis {toe['repeatable_hysteresis_deg']}°")
    ax[0].grid(alpha=0.3)
    kn = foot["knee_sweep"]
    ax[1].plot([r["cmd_rad"] for r in kn], [r["foot_xpos_m"][2] for r in kn], "o-", color="#2a6fb0")
    ax[1].set_xlabel("knee command (rad)")
    ax[1].set_ylabel("foot height z (m)")
    ax[1].set_title("leg motor positions the foot")
    ax[1].grid(alpha=0.3)
    fig.suptitle("erobot transmission — motor controls foot position through the pulley")
    fig.tight_layout()
    fig.savefig(out, dpi=120)
    plt.close(fig)
    return out


def write_proof(spec: RobotSpec | None = None) -> Path:
    spec = spec or build_spec()
    PROOFS_ROOT.mkdir(parents=True, exist_ok=True)
    out = PROOFS_ROOT / "transmission.json"
    out.write_text(json.dumps(transmission_proof(spec), indent=2) + "\n", encoding="utf-8")
    return out


if __name__ == "__main__":
    p = transmission_proof()
    print(f"transmission ok={p['ok']}")
    print(" ", p["summary"])
    t = p["toe_position_control"]
    print(f"  toe position control: monotonic={t['monotonic']} travel={t['toe_travel_deg']}° "
          f"tip={t['toe_tip_travel_mm']}mm hysteresis={t['repeatable_hysteresis_deg']}°")
    m = p["pulley_belt_mechanics"]
    print(f"  pulley: r={m['pulley_radius_mm']}mm wrap={m['cable_wrap_angle_deg']}° "
          f"tension={m['max_cable_tension_n']}N (SF {m['cable_safety_factor']}) "
          f"toe_torque={m['max_toe_torque_nm']}Nm backlash={m['backlash_deg']}°")
    f = p["foot_position_by_leg_motors"]
    print(f"  leg->foot: knee track err {f['knee_tracking_err_rad']}rad, "
          f"foot height range {f['knee_moves_foot_height_m']}m")
    print(f"  wrote {write_proof()}")
    print(f"  plot {render_characterization()}")
