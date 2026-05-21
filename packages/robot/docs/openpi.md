# OpenPI VLA backend (Physical Intelligence)

`eliza_robot.policy.openpi.OpenPIPolicyClient` wires the bridge's
`policy.start` path to a Physical Intelligence **openpi** inference
server. The server runs the VLA model; the client packs observations,
ships them over a websocket, decodes the returned action chunks, and
clamps them against the bridge safety bounds before they reach the robot.

## Install

```bash
# 1. The openpi wire-protocol client. Optional dep — not in pyproject.toml.
#    Use the official package once Physical Intelligence publishes a wheel;
#    until then, build from source.
pip install openpi-client
#    or:
# pip install git+https://github.com/Physical-Intelligence/openpi#subdirectory=packages/openpi-client

# 2. (For local server) Docker + an NVIDIA GPU for real-time inference.
```

If `openpi-client` is missing, `OpenPIPolicyClient.start()` raises an
`ImportError` whose message includes the install command.

## Architecture

```
PerceptionAggregator ──> bridge.openpi_adapter.build_observation
                                       │
                                       ▼
                        OpenPIPolicyClient.step(obs)
                                       │
                       openpi_client.WebsocketClientPolicy.infer
                                       │
                                       ▼
                  bridge.openpi_adapter.decode_action
                                       │
                       bridge.safety.check_policy_motion_bounds  (clamp)
                                       │
                                       ▼
                       ActionChunk { joints, walk_command, head_target,
                                     confidence, latency_ms }
                                       │
                                       ▼
                          bridge dispatcher → robot
```

The adapter and safety modules are imported lazily. If the bridge port
(`packages/robot/eliza_robot/bridge/openpi_adapter.py`) is not yet in
place when `OpenPIPolicyClient.start()` runs, the client raises a clear
`ImportError` pointing back to this doc.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `ELIZA_AINEX_OPENPI_ENDPOINT` | _unset_ | `ws://host:port` for the inference server. Required to run the loop. |
| `ELIZA_AINEX_OPENPI_PROFILE` | `hiwonder-ainex` | Robot profile resolved at `start()`. |
| `ELIZA_AINEX_OPENPI_TIMEOUT_S` | `2.0` | Per-step timeout used by the openpi client. |

The bridge `policy.start` payload should include
`{"policy": "openpi", "endpoint": "<ws-url>"}`. `eliza_robot.policy.dispatch.get_policy_backend("openpi", endpoint=...)`
is the single entry point — do not instantiate `OpenPIPolicyClient`
directly outside tests.

## Startup order

1. **Robot/sim up.** Bring up the websocket bridge backend (`mock`,
   `ros_real`, `isaac`, ...).
2. **openpi server up.** Either point at a remote endpoint or launch one
   locally. The placeholder launcher prints the docker command:

   ```bash
   python3 -m eliza_robot.policy.openpi.server --port 9200 --policy pi0_ainex
   # Prints something like:
   #   docker run --rm -it --gpus all -p 9200:9200 \
   #     physical-intelligence/openpi-server:latest --policy pi0_ainex
   ```

   The image reference is a TODO until Physical Intelligence publishes a
   registry-hosted build; for now, build locally from
   <https://github.com/Physical-Intelligence/openpi> following their
   server instructions and tag the result `physical-intelligence/openpi-server:latest`.

3. **Bridge policy start.** From the agent or a test harness, send:

   ```jsonc
   {
     "command": "policy.start",
     "payload": {
       "policy": "openpi",
       "endpoint": "ws://localhost:9200",
       "task": "walk to the red cup",
       "hz": 10,
       "max_steps": 500
     }
   }
   ```

## Latency budget

| Stage | Budget | Notes |
|---|---|---|
| Observation build (adapter) | < 5 ms | Pure CPU normalisation. |
| Wire round-trip (ws) | 5–50 ms | Depends on network; co-locate server in prod. |
| openpi inference | 30–150 ms | Model + GPU dependent. |
| Decode + safety clamp | < 2 ms | Bounded by a single dict pass. |

At 10 Hz the full step budget is 100 ms, leaving headroom for an
inference window up to ~70 ms before backpressure kicks in.

## Fallback behaviour

`OpenPIPolicyClient` does **not** insert silent fallbacks:

- Missing `openpi-client` → `ImportError` from `start()`.
- Missing `bridge.openpi_adapter` → `ImportError` from `start()`.
- Server returns non-dict → `TypeError` from `step()`.
- Safety guard rejects (e.g. invalid speed) → `RuntimeError` from `step()`.

The bridge `policy.start` handler is responsible for catching these,
emitting a `policy.status` event, and halting the loop. Do not catch and
log inside the client; the bridge's deadman heartbeat already covers the
"server hangs" case (no `policy.tick` within 2 s → policy stopped).

## Safety

`OpenPIPolicyClient.step()` always passes the decoded action through
`bridge.safety.check_policy_motion_bounds` (or
`bridge.safety.MotionBounds.clamp` when the bridge exposes the typed
class). The clamp limits are documented in
`docs/openpi_ainex_integration.md` (legacy SSD doc) and live in
`eliza_robot.bridge.safety`:

| Field | Min | Max |
|---|---|---|
| `walk_x` | -0.05 m/step | 0.05 m/step |
| `walk_y` | -0.05 m/step | 0.05 m/step |
| `walk_yaw` | -10° / step | 10° / step |
| `walk_height` | 0.015 m | 0.06 m |
| `walk_speed` | 1 | 4 |
| `head_pan` | -1.5 rad | 1.5 rad |
| `head_tilt` | -1.0 rad | 1.0 rad |

The bridge additionally enforces command rate limiting (30 cmd/s),
deadman heartbeats (2 s), and manual preemption — see
`packages/robot/eliza_robot/bridge/safety.py`.
