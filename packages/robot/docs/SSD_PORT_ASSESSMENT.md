# Critical Assessment: SSD AiNex Codebase Port to elizaOS/Eliza

**Scope**: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/` and sibling directories.  
**Target**: Porting to `/home/shaw/milady/eliza/packages/robot/` (Python) and `/home/shaw/milady/eliza/plugins/plugin-ainex/` (TypeScript).  
**Assessment Date**: 2025-05-18  
**Total SSD Codebase Size**: 14G  

---

## 1. Directory Inventory

### Top-Level Directories on SSD

| Directory | Purpose | Port Verdict | Notes |
|-----------|---------|-------------|-------|
| `ainex-robot-code/` | Main robot codebase (training, bridge, perception) | **DIRECT** | 26 subdirs, 14G total; core training+bridge portable |
| `training/` | Parallel to ainex-robot-code, RL training scripts & exports | **REFACTOR** | Appears to be duplicate/sibling; consolidate with ainex-robot-code/training |
| `data-capture/`, `data-pipeline/` | Data processing for training datasets | **REFERENCE-ONLY** | Specialized data ingestion; defer to v2 |
| `huggingface/` | HuggingFace models, probably fine-tuning or inference | **SKIP** | Model hosting; separate MLOps problem |
| `paper/` | ICLR 2025 submission (TeX, PDF, figures) | **REFERENCE-ONLY** | Architecture decisions documented; read for constraints |
| `hyperscape/` | Hyperscape game engine integration | **SKIP** | Game logic; already in main eliza repo |
| `printables/` | STL/printable parts for physical assembly | **SKIP** | Hardware CAD; separate CAM process |
| `fleet/` | Multi-robot orchestration (if any) | **SKIP** | Not in core path for single-robot MVP |
| `turboquant/` | KV-cache compression library (PyTorch) | **REFERENCE-ONLY** | Optional optimization; document as future enhancement |
| `eliza/` | Parallel Hyperscape-fork eliza repo | **SKIP** | Use main `/home/shaw/milady/eliza` instead |
| `GAIT_SOURCE_CODE.py` | Root file: Hiwonder gait primitives (Bezier, cubic spline) | **DIRECT** | Self-contained numpy; ~360 LOC; critical for gait baseline |
| `report.md` | Architecture narrative + prior art analysis | **REFERENCE-ONLY** | Excellent framing; 200+ lines of design rationale |

**Summary**: 
- **Direct port**: `ainex-robot-code/` (bridge, training/mujoco, training/rl, perception, eliza Python plugin)
- **Refactor**: Consolidate parallel `training/` if separate; check for overlap
- **Skip**: Game assets, multi-robot orchestration, CAD, parallel Eliza fork
- **Reference**: Report, paper, turboquant (v2 optimization)

---

## 2. Dependency Graph

### Heavyweight (GPU/specialized)
- **jax[cuda12] ≥0.4.30**, **jaxlib** — core JAX for RL training
- **mujoco ≥3.5.0**, **mujoco-mjx ≥3.5.0** — physics + MJX GPU acceleration
- **brax ≥0.12.0** — PPO trainer built on JAX
- **torch ≥2.4.0**, **torchvision ≥0.19.0** — vision backbone + fine-tuning
- **transformers ≥4.49.0** — HuggingFace models (inference + LoRA)
- **sentence-transformers** — entity embedding (implied in perception pipeline)
- **diffusers** — diffusion models (fine-tuning pipeline)

### Medium (standard ML/control)
- **websockets ≥12.0, <14.0** — bridge WebSocket server
- **opencv-python ≥4.8.0** — perception, camera frames
- **numpy <2** (pinned <2 for JAX compat)
- **pydantic ≥2.0** — schema validation (canonical world state)
- **pytest** — testing framework
- **flax ≥0.10.0**, **optax ≥0.2.0**, **orbax-checkpoint ≥0.10.0** — JAX ecosystem
- **ml_collections** — config management
- **pyyaml** — YAML loading

### Small (utilities)
- **ml_collections** — nested config dicts
- **Pillow ≥10.0.0** — image loading/manipulation
- **tqdm**, **accelerate** — training utilities
- **einops** — tensor reshaping for vision
- **omegaconf** — alternative config system
- **safetensors**, **bitsandbytes ≥0.43.0**, **peft ≥0.8.0**, **trl ≥0.7.0** — fine-tuning support
- **datasets** — HuggingFace dataset loading
- **open_clip_torch** — vision models

**Pinned versions in source**:
- `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/requirements.txt`: Exact pins: `mujoco>=3.5.0`, `mujoco-mjx>=3.5.0`, `jax[cuda12]>=0.4.30`, `brax>=0.12.0`
- `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/bridge/requirements.txt`: `websockets>=12.0,<14.0`
- `/media/shaw/Extreme SSD/hyperscape-robot-workspace/training/requirements.txt`: Tight on torch, transformers, no upper bound on most JAX deps

**Risk**: JAX+JAXlib version skew; numpy<2 constraint will bite if dependencies pull numpy2; mujoco-mjx versioning must track mujoco exactly.

---

## 3. Bridge Protocol & Commands

### Protocol Envelopes
Source: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/bridge/protocol.py`

**CommandEnvelope** (client → server):
```python
{
  "type": "command",
  "request_id": str,
  "timestamp": str (ISO 8601),
  "command": str,
  "payload": dict,
  "preempt": bool = False
}
```

**ResponseEnvelope** (server → client):
```python
{
  "type": "response",
  "request_id": str,
  "timestamp": str,
  "ok": bool,
  "backend": str,
  "message": str,
  "data": dict
}
```

**EventEnvelope** (server → client, async):
```python
{
  "type": "event",
  "event": str,
  "timestamp": str,
  "backend": str,
  "data": dict
}
```

### Valid Commands
From `protocol.py` lines 93–104:

| Command | Payload | Purpose |
|---------|---------|---------|
| `walk.set` | `{speed: 1-4, height: 0.015-0.06, x: -0.05-0.05, y: -0.05-0.05, yaw: -10-10}` | Set walk parameters (velocity + height) |
| `walk.command` | `{action: "start"\|"stop"\|"enable"\|"disable"\|"enable_control"\|"disable_control"}` | Control walk state machine |
| `head.set` | `{pan: -1.5-1.5 rad, tilt: -1.0-1.0 rad, duration: 0-5 s}` | Pan/tilt head |
| `action.play` | `{name: str}` | Play predefined action/gesture |
| `servo.set` | `{duration: 0-5, positions: [{id: 1-24, position: 0-1000}]}` | Direct servo PWM control |
| `policy.start` | `{task: str, hz?: 1-30, model?: str, max_steps?: 1-100000}` | Launch RL policy |
| `policy.stop` | `{}` | Stop active policy |
| `policy.tick` | `{}` | Single step (used with external loop) |
| `policy.status` | `{}` | Query policy state |

### Valid Events
From `protocol.py` lines 106–116:

| Event | Data | Purpose |
|-------|------|---------|
| `session.hello` | `{backend: str, version: str, ...}` | Server boot announcement |
| `telemetry.basic` | `{battery_mv, roll, pitch, walking: bool, ...}` | IMU + battery snapshot |
| `telemetry.perception` | `{entities: [...], image_metadata: {...}}` | Vision pipeline output |
| `telemetry.policy` | `{task, step, reward, observation, action}` | RL policy telemetry |
| `safety.deadman_triggered` | `{reason: str}` | Watchdog / rate-limit violation |
| `safety.policy_guard` | `{rejected: bool, reason: str}` | Pre-execution action validation |
| `policy.status` | `{running: bool, task: str, step: int}` | Async policy state update |

### Validation Rules
Source: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/bridge/validation.py`

- **walk.set**: height must be `[0.015, 0.06]`; x,y must be `[-0.05, 0.05]`; yaw must be `[-10, 10]`; speed must be `[1,2,3,4]`
- **walk.command**: action restricted to whitelisted strings
- **head.set**: pan `[-1.5, 1.5]`; tilt `[-1, 1]`; duration `(0, 5]`
- **servo.set**: 1-24 servo IDs; position `[0, 1000]`; duration `(0, 5]`
- **policy.start**: task must be non-empty string; hz `[1, 30]`; max_steps `[1, 100000]`

**Port notes**:
- Protocol is language-agnostic JSON; TypeScript port needs encoder/decoder
- Validation logic should live in shared schema, not duplicated
- Telemetry events are asynchronous; plugin needs event listener pattern
- `policy.tick` requires external control loop (useful for debugging)

---

## 4. Training Stack: MuJoCo Environments

### Environments in `training/mujoco/`

**Core Environments** (all inherit from `AiNexEnv` or `MjxEnv`, JAX-compatible):

| Environment | File | Class | Obs Dims | Reward Terms | Status |
|-------------|------|-------|----------|--------------|--------|
| **Joystick** | `joystick.py` | `Joystick(AiNexEnv)` | ~60 (gyro+gravity+joint+vel+action+history) | track_lin_vel (10), track_ang_vel (6), feet_phase (0.5), orientation, energy | **Active** (v23+v26 tuning) |
| **Target Reaching** | `target.py` | `TargetReaching(AiNexEnv)` | ~70 (+ target position) | reach_target (8), lin_vel_z (-2), orientation, stand_still, energy | **Active** |
| **GetUp** | `getup.py` | `GetUp(AiNexEnv)` | ~50 (gyro+gravity+joint+vel+last_action) | orientation (1.0), torso_height (5.0), posture (2.0), stand_still (2.0), action_rate, dof_limits | **Active** (recovery from falls) |
| **Grasp** | `grasp.py` | `Grasp(MjxEnv)` | ~80 (all dofs + object pose + gripper state) | reach_distance (8), grasp_contact (5), grasp_hold (20), stability | **Active** (needs scene XML) |
| **Carry** | `carry.py` | `Carry(MjxEnv)` | ~100 (grasp + locomotion + object tracking) | reach (5), grasp_contact (3), grasp_hold (10), target_distance (10), delivery (50) | **Active** (multi-phase) |
| **Place** | `place.py` | `Place(MjxEnv)` | ~80 (grasped object assumed, lower + release) | approach_target (8), lower_object (5), release_precision (15), placement_success (50) | **Active** |
| **Wave** | `wave_env.py` | `WaveEnv(CompositionalEnv)` | ~70 (upper-body focus) | gesture_tracking, action smoothness | **Active** (upper-body only) |
| **Compositional** | `compositional_env.py` | `CompositionalEnv(AiNexEnv)` | Configurable (multi-task) | Weighted sum of subgoal rewards | **Experimental** (meta-RL) |
| **Demo** | `demo_env.py` | `DemoEnv` (non-JAX) | Includes egocentric camera, red ball track | walk_to_ball reward | **Demo-only** (CPU inference) |

### Base Environment
Source: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/training/mujoco/base_env.py`

`AiNexEnv(MjxEnv)` provides:
- **Model loading**: `ainex_primitives.xml` (pure-shape, no meshes, GPU-fast)
- **PD control**: Kp=200, Kd=5 on leg actuators (hardcoded in ctor)
- **Sensor access**: Feet site IDs, contact sensors, IMU, joint states
- **Shared costs**: Torque penalty, action smoothing, joint limit violation

**Key asset files** (in `training/mujoco/`):
- `ainex.xml` — original mesh model (unused for training)
- `ainex_primitives.xml` — training model (capsules, boxes, no meshes)
- `ainex_primitives_realistic.xml` — corrected mass/force
- `ainex_grasp_scene.xml` — extends primitives + graspable object + contacts
- `ainex_mjx.xml` — MJX variant (if different)
- `ainex_constants.py` — DOF counts, body names, site names

### Reward Function Patterns

**Shared reward scales** (from `joystick.py` default config):
```python
tracking_lin_vel: 10.0
tracking_ang_vel: 6.0
orientation: -1.5
torques: -0.0001
action_rate: -0.01
feet_phase: 0.5  # Bezier gait tracking
```

**Notable observations**:
1. **Gait phase reward** (feet_phase=0.5) uses Bezier interpolation from `GAIT_SOURCE_CODE.py`
2. **Termination reward** (-1.0) penalizes episode cutoff (fall detection)
3. **Entity slots** (152-dim perception encoding) can be attached to observation if `enable_entity_slots=True`
4. **No NaN traps detected** in reward logic (pure JAX, vectorized)

### Tests
**Count**: 9 test files in `training/mujoco/tests/`:
- `test_joystick_env.py` — basic env init + step
- `test_target_env.py` — target spawn + distance reward
- `test_sensors.py` — IMU/contact sensor access
- `test_inference.py` — checkpoint loading + inference
- `test_domain_randomization.py` — DR curriculum
- `test_train.py` — training loop
- `test_compositional_env.py` — multi-task
- `test_entity_slot_training.py` — perception encoding
- `test_arm_control.py` — arm trajectory tracking

All use `JAX_PLATFORMS=cpu pytest` (no GPU required for unit tests).

---

## 5. Checkpoints Inventory

### Location & Size
Path: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/checkpoints/`  
Total: **2.2G** across 20 directories

### Checkpoint Directory Listing
```
mujoco_locomotion_v1-v7         ~1.0M each (early iterations)
mujoco_locomotion_v10-v20       ~1.0M each (20 latest iterations)
mujoco_locomotion_v13_flat_feet ~1.0M (special: flat-footed variant)
mujoco_locomotion_v14-v20       ~1.0M each (recent; v20 is latest)

Total files per checkpoint: config.json (~1.7K), metrics.json (~1.3K)
  (Very lightweight—actual weights likely stored in separate neural-net checkpoints)
```

### Checkpoint Selection for CI Smoke Test

**Best candidate**: `mujoco_locomotion_v20/` (latest, ~2.0M)
- Contains: `config.json`, `metrics.json`
- Suitable for: 5-step inference smoke test
- **Decision**: Include v20 config in repo; skip binary weights (use download script)

**Alternative**: Create a minimal 10-step policy checkpoint (~5MB) for unit test

**Risk**: If weights are stored elsewhere (S3, HuggingFace), CI script must fetch them; current checkpoint dirs contain only JSON metadata.

---

## 6. Hiwonder Gait: GAIT_SOURCE_CODE.py

### File Location & Size
`/media/shaw/Extreme SSD/hyperscape-robot-workspace/GAIT_SOURCE_CODE.py`  
~360 lines, pure NumPy, self-contained

### Key Functions

**`get_rz(phi, swing_height=0.08)`** (lines 18–86)
- **Purpose**: Compute desired foot Z-position (height) over gait cycle
- **Input**: Phase φ ∈ [-π, π] (per-foot), swing_height ∈ (0, 0.4)
- **Output**: Desired Z position (normalized foot height)
- **Method**: Cubic Bezier interpolation (custom S-curve, not standard Bezier)
- **Formula**: `x³ + 3(x²(1-x))` creates smooth stance→swing→stance phase
- **Usage in environments**: Called per-foot to generate phase-based reward term

**`initialize_gait_phase(rng, dt, gait_freq_range, foot_height_range)`** (lines 92–150)
- **Purpose**: Sample gait parameters (frequency, foot height) at episode reset
- **Returns**: Dict with `phase`, `phase_dt`, `gait_freq`, `foot_height`
- **Typical ranges**: gait_freq 1.0–1.5 Hz, foot_height 0.08–0.15 m
- **Usage**: Called once per env.reset() to randomize gait curriculum

### Integration Path

1. **Currently**: Bezier gait is embedded in joystick.py (via mujoco_playground reference)
2. **To port**: Extract `get_rz()` + `initialize_gait_phase()` to `packages/robot/gait.py`
3. **Missing**: Wire-up to actual MuJoCo foot site positions (requires env modifications)

### Completeness Check

**Self-contained**: Yes (only `numpy`)  
**Missing**: 
- No controller logic (i.e., no PD loop that uses desired_z)
- No phase update step (caller must track φ and increment by phase_dt)
- No multi-foot synchronization (caller must offset phases: left=0, right=π)

**Port verdict**: **DIRECT** with minor integration glue

---

## 7. Eliza Python Plugin (elizaos_plugin_ainex)

### Location
`/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/eliza/packages/python/elizaos_plugin_ainex/`

### Files & Responsibilities

| File | Role | Actions/Providers |
|------|------|-------------------|
| `plugin.py` | Plugin registration | Registers all actions + providers to ElizaOS runtime |
| `actions.py` | Command handlers | `walk_command`, `walk_set`, `policy_start`, `policy_stop`, `policy_tick`, `policy_status`, `action_play`, `head_set`, `servo_set` |
| `providers.py` | Scene state suppliers | `get_robot_state`, `get_environment_state`, `get_available_actions` |
| `bridge_client.py` | WebSocket client | `AinexBridgeClient` with async command/event methods |
| `execution_service.py` | Intent executor | Maps LLM output → RL policy invocation + monitoring |
| `replanner.py` | Failure recovery | Re-plans if action fails or timeout |
| `agent.py` | Agent lifecycle | Wraps ElizaOS agent with robot-specific context |
| `cli.py` | Command-line entry | Start agent, list plugins, etc. |

### Actions (From `actions.py`)

**walk_command_handler**: 
- Validates `action ∈ {start, stop, enable, disable, enable_control, disable_control}`
- Calls `client.walk_command(action)`
- Returns ActionResult with success/message

**walk_set_handler**:
- Params: `x, y, yaw, speed, height`
- Applies range validation (x,y ∈ [-0.05, 0.05], height ∈ [0.015, 0.06], speed ∈ [1,2,3,4])
- Calls `client.walk_set(...)`

**policy_start_handler**:
- Params: `task, hz?, max_steps?`
- Launches RL policy via `client.policy_start(task, ...)`

**(Other actions)**: head_set, servo_set, action_play, policy_stop, policy_tick, policy_status — similar pattern

### Providers (From `providers.py`)

**get_robot_state()**:
- Returns: Dict with battery_mv, IMU roll/pitch, walking state, available actions
- Uses `_battery_percentage()` and `_imu_stability()` helper functions

**get_environment_state()**:
- Returns: Detected entities, entity poses, entity types, spatial descriptions

**_bearing_description(x, y, z)**:
- Produces text like "1.5m ahead-left, bearing: 0.3 rad"
- Used for LLM context

### Port Strategy for TypeScript

**Current**: Python ElizaOS plugin (elizaos Python interop)  
**Target**: Rewrite as TypeScript plugin in `/home/shaw/milady/eliza/plugins/plugin-ainex/`

**Feature parity needed**:
1. Bridge client (WebSocket, command/event model) → adapt existing plugin-websocket patterns
2. Actions: walk_command, walk_set, policy_start/stop, head_set, servo_set, action_play
3. Providers: robot_state, environment_state, available_actions
4. Execution service: Policy monitoring + telemetry display in LLM context

**Risk**: Python plugin currently depends on `bridgeClient` instance injected at runtime; TypeScript port must establish similar injection or DI pattern.

---

## 8. OpenPI Integration: Bridge Adapters

### openpi_adapter.py
Source: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/bridge/openpi_adapter.py`

**build_observation(perception: AinexPerceptionObservation) → OpenPIObservationPayload**

Translates robot perception into OpenPI VLA wire format:
- **State**: 11-dim proprioception (walk_x/y/yaw, walk_height, walk_speed, head_pan/tilt, imu_roll/pitch, is_walking, battery)
  + 152-dim entity slots (from perception encoder)
  = 163-dim observation
- **Prompt**: Language instruction (if any)
- **Image**: Camera frame (base64 or tensor reference)
- **Metadata**: Schema version, timestamp, entity list, battery voltage

**Action decoding** (reverse direction):
- `decode_action(response)` → dict with arm/leg joint targets
- Clamps to [-1, 1] and denormalizes to physical ranges

### openpi_loop.py
Source: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/bridge/openpi_loop.py`

**OpenPIPolicyLoop** class:

Manages:
1. **Perception pipeline** (background thread, OpenCV or custom frame source)
2. **Perception aggregator** (merges camera frames + robot telemetry)
3. **Policy query loop** (calls OpenPI server at fixed Hz)
4. **Action dispatch** (sends commands to bridge backend)

**Methods**:
- `start_perception(frame_source)` — Launch perception thread
- `update_telemetry(data)` — Inject robot state
- `step()` — Query policy, dispatch action

**Env vars / Endpoints**:
- Policy URL: `--policy-url http://localhost:8000/infer` (default)
- Camera device: `--camera-device 0` (default)
- Hz: `--hz 10.0` (default)

**Risk**: 
- OpenPI server contract not fully documented in codebase
- Assumes synchronous HTTP `/infer` endpoint
- No fallback if policy server is unavailable

### Port notes:
- Observation/action normalization is independent of backend; **DIRECT** port
- OpenPI loop is Python-specific; TypeScript plugin wraps bridge commands instead of polling policy server

---

## 9. Test Inventory & Coverage

### Test File Count
Total: **259 test files** across entire ainex-robot-code

### By Major Directory

| Directory | Count | Key Tests |
|-----------|-------|-----------|
| `bridge/tests/` | 27 | protocol parsing, command validation, backend parity, safety |
| `training/mujoco/tests/` | 9 | env init, inference, domain randomization, entity slots |
| `training/rl/tests/` | 6 | skill registry, command parser, Brax policy deployment |
| `training/schema/tests/` | 2 | embodied context, hyperscape adapter |
| `training/demo/tests/` | 1 | demo env |
| `training/trajectory_db/tests/` | 1 | trajectory database |
| `training/datasets/tests/` | 1 | fine-tuning data formatting |
| `perception/tests/` | 20 | multicam fusion, ArUco, YOLO, entity slot encoding |
| `benchmarks/` | 160+ | (OSWorld, GAIA, SWE-bench, etc.; not robot-specific) |
| Other eliza/examples | 20+ | (agent-bench, LLM integration, etc.) |

### Robot-Specific Critical Tests

**High priority** (must port):
1. `training/mujoco/tests/test_joystick_env.py` — Joystick env + Bezier gait
2. `training/mujoco/tests/test_inference.py` — Checkpoint loading + inference
3. `bridge/tests/test_protocol.py` (if exists) — Protocol validation
4. `training/rl/tests/test_brax_target_skill.py` — Skill deployment

**Medium priority** (port or mock):
1. `perception/tests/` — Detector init (may require YOLO weights)
2. `training/trajectory_db/tests/` — DB schema (pure Python, no GPU)

**Low priority** (skip or defer):
1. Benchmarks (60+ unrelated test files)
2. Hyperscape integration tests (game-specific)

### Test Command
```bash
JAX_PLATFORMS=cpu python -m pytest training/trajectory_db/tests/ \
  perception/multicam/tests/ training/rl/tests/ \
  training/schema/tests/ training/datasets/tests/ \
  training/demo/tests/ -q
```

---

## 10. Known Broken Or Open Items

### Severity Analysis

**No critical open implementation items found** in main robot code (training/,
bridge/, perception/).

Scattered DEBUG logging pragmas:
- `run_visualizer.py`: `logging.DEBUG if args.verbose else logging.INFO`
- `training/finetune/*.py`: Same logging guard (not a blocker)

**External labeling-tool note**:
- `software/labelImg/libs/canvas.py` line ~800 comments on shape-boundary
  behavior in the upstream labeling UI; it is not robot-critical.

### Potential Risk Areas

1. **OpenPI endpoint contract** — Adapter assumes synchronous HTTP; no graceful fallback if server slow/unavailable
2. **Checkpoint loading** — v20 checkpoint dirs contain only JSON; actual policy weights location unclear (S3? GCS?)
3. **Grasp/Place environments** — Require `ainex_grasp_scene.xml` which extends primitives model; collision geometry untested
4. **Perception encoder** — Entity slots assume 152-dim output; if encoder changes, observation dim breaks
5. **Compositional task** — `compositional_env.py` uses multi-phase reward; limited test coverage

### Missing Roadmap Items

No explicit unstarted sections found. Code appears actively maintained (latest
checkpoint is `v20`, March 26).

---

## 11. Paper & Report: Architecture Constraints

### Key Documents
1. **`report.md`** (17KB) — Shaw's framing of the problem
2. **`paper/llm_agents_rpg_robots_v2.tex`** (35KB) — ICLR 2025 draft
3. **`paper/llm_agents_rpg_robots_v2.pdf`** (75MB) — Rendered version

### Architecture Decisions to Honor

From `report.md` (lines 39–92):

**EmbodiedContext** abstraction:
```python
type EmbodiedContext = {
  episodeId, stepId, t,
  instruction, dialogue, memorySummary,
  cameras: {egoRgb, egoDepth, overheadRgb, overheadDepth},
  transforms: {worldFromRobot, worldFromEgoCam, worldFromOverheadCam},
  entities: [{id, type, slot, pose, velocity, affordances, relations, confidence, provenance}],
  agent: {basePose, joints, contacts, heldEntityIds, locomotionState, manipulationState},
  task: {phase, constraints, successCriteria}
}
```

**GroundedIntent** output from planner:
```python
type GroundedIntent = {
  verb: "navigate_to" | "face_entity" | "reach_to" | "grasp" | "carry_to" | "place",
  targetEntityId?, targetPose?, parameters, constraints, success
}
```

**Critical constraints**:
1. **Planner outputs intents, not raw torques** — hierarchical, not monolithic
2. **Hyperscape traces are for semantics, not motor control** — separate agent-training from robot-learning datasets
3. **Whole-body composition is hard** — train locomotion + manipulation separately, then compose
4. **Text conditioning must be staged** — start with structured intents, move to templated text later
5. **Safety is separate from alignment** — need motion limits, contact guards, fall detection (not just LLM guardrails)

### Implications for Port

- **Schema**: Bridge protocol (walk.set, policy.start) aligns with GroundedIntent verbs
- **Perception**: Entity slots must feed into EmbodiedContext (done in openpi_adapter.py)
- **Training**: Joystick (velocity tracking) + target (navigation) environments are foundational; grasp/carry are compositions
- **Safety**: Include rate limiters, deadman switch, fall detection (already in bridge/safety.py)

---

## 12. Recommended Port Order

### Phase 1: Foundation (Weeks 1–2)
1. **Port bridge protocol** → `packages/robot/bridge_protocol.py`
   - CommandEnvelope, ResponseEnvelope, EventEnvelope
   - Command/event validators
   - Dependency: None
   
2. **Port WebSocket bridge client** → `packages/robot/bridge_client.py`
   - Async command/event dispatch
   - Reconnection logic
   - Dependency: bridge_protocol

3. **Port GAIT_SOURCE_CODE** → `packages/robot/gait.py`
   - `get_rz()`, `initialize_gait_phase()`
   - No dependencies
   - Tested independently

### Phase 2: Simulation (Weeks 2–3)
4. **Port MuJoCo environments** → `packages/robot/mujoco_env.py`
   - AiNexEnv, Joystick, TargetReaching, GetUp
   - Include assets (XMLs)
   - Dependency: JAX, mujoco, mujoco-mjx, brax

5. **Port RL skills** → `packages/robot/rl_skills/`
   - brax_walk_skill, brax_target_skill, composite_skill
   - Checkpoint loading + inference
   - Dependency: MuJoCo envs, Brax

### Phase 3: Plugin (Weeks 3–4)
6. **TypeScript plugin port** → `plugins/plugin-ainex/`
   - Actions: walk_command, walk_set, policy_start/stop, head_set, action_play
   - Providers: robot_state, environment_state
   - Bridge client wrapper
   - Dependency: bridge_protocol, bridge_client

7. **Execution service** → `packages/robot/execution_service.ts`
   - Policy monitoring, action dispatch
   - Telemetry aggregation
   - Dependency: bridge_client, RL skills

### Phase 4: Perception (Weeks 4–5)
8. **Port perception pipeline** → `packages/robot/perception/`
   - Entity slot encoder, YOLO detector, ArUco fusion
   - Camera frame source
   - Dependency: opencv-python, transformers (YOLO), ArUco

9. **OpenPI adapter** → `packages/robot/openpi_adapter.py`
   - Observation builder, action decoder
   - Dependency: perception, canonical schema

### Phase 5: Integration (Weeks 5–6)
10. **Canonical schema** → `packages/robot/canonical_schema.py`
    - EmbodiedContext, GroundedIntent, normalization helpers
    - Dependency: None (foundation)

11. **End-to-end demo** → examples/robot_walk_to_target/
    - MuJoCo sim + bridge server + TypeScript plugin
    - Dependency: All above

### Dependency DAG

```
gait.py (independent)
  ↓
canonical_schema.py (independent)
  ↓
mujoco_env.py ← (gait.py, canonical_schema.py)
  ↓
rl_skills/ ← (mujoco_env.py)
  ↓
bridge_protocol.py (independent)
  ↓
bridge_client.py ← (bridge_protocol.py)
  ↓
perception/ ← (canonical_schema.py)
  ↓
openpi_adapter.py ← (perception/, canonical_schema.py)
  ↓
execution_service.ts ← (bridge_client.py, rl_skills/, openpi_adapter.py)
  ↓
plugin-ainex/ ← (execution_service.ts, bridge_client.py)
```

---

## 13. Risk Assessment & Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|-----------|
| JAX+JAXlib version skew | Training fails | Medium | Pin all JAX ecosystem versions; test in CI on fresh venv |
| numpy<2 constraint breaks | Training fails | Medium | Upgrade numpy constraint in requirements, test with numpy 1.26.x + 2.x |
| Checkpoint weights location unclear | Inference fails | High | Audit checkpoint dirs; create S3 download script if needed |
| Grasp scene XML untested | Sim crashes | Medium | Add unit test for grasp_scene.xml XML parsing + MuJoCo load |
| OpenPI server unavailable | Policy loop hangs | Medium | Add timeout + fallback to Joystick behavior; document setup |
| Entity slot encoder dimension change | Obs shape mismatch | Low | Test perception pipeline initialization; log dim on startup |
| Bridge protocol in-the-wild | Clients diverge | Low | Publish protocol spec as JSON schema; enforce in CI |
| Perception not real-time | Plugin latency | Medium | Profile perception pipeline; consider HW acceleration (TensorRT) |
| Multi-foot gait phase sync | Broken walking | Medium | Test Bezier gait with all 4 legs; verify phase offsets |
| TypeScript plugin feature parity | Reduced capabilities | Medium | Maintain feature checklist; automated parity tests |

---

## 14. Summary: Port Verdicts by Component

| Component | Size | Verdict | Effort | Notes |
|-----------|------|---------|--------|-------|
| Bridge protocol + client | 400 LOC | **DIRECT** | 1 day | JSON envelopes, async WebSocket |
| GAIT_SOURCE_CODE | 360 LOC | **DIRECT** | 0.5 day | Pure numpy, no deps |
| MuJoCo environments (joystick + target + getup) | ~2500 LOC | **DIRECT** | 2 days | JAX+MuJoCo standard patterns |
| RL skills (walk, target, composite) | ~1500 LOC | **DIRECT** | 1.5 days | Checkpoint loading, inference |
| Perception pipeline | ~3000 LOC | **REFACTOR** | 3 days | Extract core; defer YOLO/ArUco tuning |
| OpenPI adapter | 400 LOC | **DIRECT** | 1 day | Pure schema translation |
| Trajectory DB | 800 LOC | **DIRECT** | 1 day | SQLite + Pydantic models |
| Eliza Python plugin | 800 LOC | **REFACTOR** | 2 days | Rewrite as TypeScript; adapt bridge client pattern |
| Tests (robot-critical) | 259 tests (20 core) | **DIRECT** | 2 days | Adapt to new package structure |
| Assets (XMLs, URDFs) | 6 files (~200KB) | **DIRECT** | 0.5 day | Copy verbatim; check paths |

**Total estimated porting effort**: **14–16 engineer-days** for foundational MVP  
**Critical path**: Bridge → Env → Skills → Plugin → Demo (6–8 days)

---

## Appendix: File Paths Reference

### Key Source Files (Read-Only Assessment)

**Bridge**:
- Protocol: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/bridge/protocol.py`
- Validation: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/bridge/validation.py`
- Server: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/bridge/server.py`
- OpenPI: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/bridge/openpi_adapter.py`, `openpi_loop.py`

**Training**:
- Environments: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/training/mujoco/{joystick,target,getup,grasp,carry,place,compositional_env}.py`
- Base: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/training/mujoco/base_env.py`
- RL Skills: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/training/rl/skills/{brax_walk_skill,brax_target_skill,composite_skill}.py`
- Trajectory DB: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/training/trajectory_db/{db,schema,models}.py`
- Schema: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/training/schema/canonical.py`

**Gait**:
- `/media/shaw/Extreme SSD/hyperscape-robot-workspace/GAIT_SOURCE_CODE.py`

**Perception**:
- Pipeline: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/perception/pipeline.py`
- Entity slots: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/perception/entity_slots/sim_provider.py`

**Plugin (Eliza)**:
- `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/eliza/packages/python/elizaos_plugin_ainex/{actions,providers,execution_service,bridge_client}.py`

**Documentation**:
- Report: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/report.md`
- README: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/README.md`
- Paper: `/media/shaw/Extreme SSD/hyperscape-robot-workspace/paper/llm_agents_rpg_robots_v2.{tex,pdf}`

---

**End of Assessment**
