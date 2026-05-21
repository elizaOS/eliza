// Owns the AinexBridgeClient connection and caches the latest telemetry
// snapshots for providers. Actions read the live `bridge` to send commands;
// providers read the cached snapshots to render context for the LLM.

import {
  type IAgentRuntime,
  Service,
  type ServiceTypeName,
  logger,
} from "@elizaos/core";
import { AinexBridgeClient } from "./bridge-client";
import {
  loadProfileFromBridge,
} from "./profile-schema";
import type {
  EventEnvelope,
  JsonDict,
  RobotProfileDescriptor,
} from "./types";

export interface BasicTelemetrySnapshot {
  battery_mv: number;
  is_walking: boolean;
  imu_roll: number;
  imu_pitch: number;
  walk_x: number;
  walk_y: number;
  walk_yaw: number;
  walk_speed: number;
  walk_height: number;
  head_pan: number;
  head_tilt: number;
  joint_positions: Record<string, number>;
  receivedAt: number;
}

export interface PerceptionEntity {
  entity_id: string;
  label: string;
  confidence: number;
  x: number;
  y: number;
  z: number;
  distance?: number;
  source?: string;
}

export interface PerceptionSnapshot {
  entities: PerceptionEntity[];
  receivedAt: number;
}

export interface PolicyStatusSnapshot {
  state: string;
  reason: string;
  task: string;
  step: number;
  trace_id: string;
  planner_step_id: string;
  canonical_action: string;
  target_entity_id: string;
  target_label: string;
  receivedAt: number;
}

export interface SafetySnapshot {
  reason: string;
  ageSec: number | null;
  step: number | null;
  receivedAt: number;
}

function _toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function _toBool(value: unknown): boolean {
  return value === true;
}
function _toString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export class AinexService extends Service {
  static override serviceType: ServiceTypeName = "ainex" as ServiceTypeName;
  override capabilityDescription =
    "Drives a Hiwonder AiNex (or compatible) humanoid robot through the AiNex websocket bridge.";

  private bridge: AinexBridgeClient | null = null;
  private profile: RobotProfileDescriptor | null = null;
  private telemetry: BasicTelemetrySnapshot | null = null;
  private perception: PerceptionSnapshot | null = null;
  private policy: PolicyStatusSnapshot | null = null;
  private safety: SafetySnapshot | null = null;
  private connectedAt: number | null = null;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<AinexService> {
    const service = new AinexService(runtime);
    await service._tryConnect();
    return service;
  }

  /** Live websocket client, or null when the bridge is unreachable. */
  getBridge(): AinexBridgeClient | null {
    return this.bridge;
  }

  /** Active robot profile (resolved via profile.describe), or null. */
  getProfile(): RobotProfileDescriptor | null {
    return this.profile;
  }

  /** Latest basic telemetry snapshot, or null when nothing has arrived yet. */
  getTelemetry(): BasicTelemetrySnapshot | null {
    return this.telemetry;
  }

  /**
   * Fetch a single camera snapshot through the bridge. Returns the decoded
   * base64 PNG bytes (without the data URL prefix) plus the advertised
   * width/height. Throws when the bridge is offline or the backend does
   * not expose a camera.
   */
  async snapshotCamera(
    camera: string = "head",
  ): Promise<{ frameBase64: string; width: number; height: number; format: string; camera: string }> {
    if (!this.bridge || !this.bridge.isConnected()) {
      throw new Error("AinexService.snapshotCamera: bridge not connected");
    }
    const payload: Record<string, string> = {};
    if (camera !== "head") payload.camera = camera;
    const response = await this.bridge.send("camera.snapshot", payload);
    if (!response.ok) {
      throw new Error(
        `AinexService.snapshotCamera: ${response.message ?? "bridge error"}`,
      );
    }
    const data = response.data as {
      camera?: string;
      format?: string;
      width?: number;
      height?: number;
      frame_base64?: string;
    };
    if (
      typeof data.frame_base64 !== "string" ||
      typeof data.width !== "number" ||
      typeof data.height !== "number"
    ) {
      throw new Error("AinexService.snapshotCamera: malformed response");
    }
    return {
      camera: data.camera ?? camera,
      format: data.format ?? "png",
      width: data.width,
      height: data.height,
      frameBase64: data.frame_base64,
    };
  }

  getPerception(): PerceptionSnapshot | null {
    return this.perception;
  }

  getPolicyStatus(): PolicyStatusSnapshot | null {
    return this.policy;
  }

  getSafety(): SafetySnapshot | null {
    return this.safety;
  }

  /** True once the websocket open handshake has completed. */
  isConnected(): boolean {
    return this.bridge?.isConnected() === true;
  }

  async stop(): Promise<void> {
    const bridge = this.bridge;
    this.bridge = null;
    this.connectedAt = null;
    if (bridge) {
      await bridge.disconnect();
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private _readSetting(key: string): string | null {
    const raw = this.runtime.getSetting(key);
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") return raw === "" ? null : raw;
    return String(raw);
  }

  private async _tryConnect(): Promise<void> {
    const url =
      this._readSetting("ELIZA_AINEX_BRIDGE_URL") ?? "ws://localhost:9100";
    const client = new AinexBridgeClient({ url });
    this._registerEventHandlers(client);
    try {
      await client.connect();
      this.bridge = client;
      this.connectedAt = Date.now();
      logger.info(`[AinexService] connected to bridge ${url}`);
      this.profile = await loadProfileFromBridge(client);
    } catch (err) {
      // The bridge may not be up at agent start (e.g. user hasn't launched
      // `python -m eliza_robot.bridge.server` yet). Hold a disconnected
      // service; the autoReconnect path in the client will recover, but
      // until then providers return "not connected" and actions error loudly.
      logger.warn(
        `[AinexService] bridge unreachable at ${url}: ${(err as Error).message}`,
      );
      this.bridge = client;
    }
  }

  private _registerEventHandlers(client: AinexBridgeClient): void {
    client.on("telemetry.basic", (env) => this._onBasic(env));
    client.on("telemetry.perception", (env) => this._onPerception(env));
    client.on("telemetry.policy", (env) => this._onPolicyTelemetry(env));
    client.on("policy.status", (env) => this._onPolicyStatus(env));
    client.on("safety.deadman_triggered", (env) => this._onDeadman(env));
    client.on("safety.policy_guard", (env) => this._onPolicyGuard(env));
  }

  private _onBasic(env: EventEnvelope): void {
    const d = env.data;
    this.telemetry = {
      battery_mv: _toNumber(d.battery_mv, 0),
      is_walking: _toBool(d.is_walking),
      imu_roll: _toNumber(d.imu_roll, 0),
      imu_pitch: _toNumber(d.imu_pitch, 0),
      walk_x: _toNumber(d.walk_x, 0),
      walk_y: _toNumber(d.walk_y, 0),
      walk_yaw: _toNumber(d.walk_yaw, 0),
      walk_speed: _toNumber(d.walk_speed, 0),
      walk_height: _toNumber(d.walk_height, 0),
      head_pan: _toNumber(d.head_pan, 0),
      head_tilt: _toNumber(d.head_tilt, 0),
      joint_positions:
        d.joint_positions && typeof d.joint_positions === "object" &&
        !Array.isArray(d.joint_positions)
          ? (Object.fromEntries(
              Object.entries(d.joint_positions as JsonDict).map(([k, v]) => [
                k,
                _toNumber(v, 0),
              ]),
            ))
          : {},
      receivedAt: Date.now(),
    };
  }

  private _onPerception(env: EventEnvelope): void {
    const entitiesValue = env.data.entities;
    const entities: PerceptionEntity[] = Array.isArray(entitiesValue)
      ? entitiesValue
          .filter((e): e is JsonDict => typeof e === "object" && e !== null && !Array.isArray(e))
          .map((e) => ({
            entity_id: _toString(e.entity_id, ""),
            label: _toString(e.label, ""),
            confidence: _toNumber(e.confidence, 0),
            x: _toNumber(e.x, 0),
            y: _toNumber(e.y, 0),
            z: _toNumber(e.z, 0),
            distance: typeof e.distance === "number" ? e.distance : undefined,
            source: typeof e.source === "string" ? e.source : undefined,
          }))
      : [];
    this.perception = { entities, receivedAt: Date.now() };
  }

  private _onPolicyTelemetry(env: EventEnvelope): void {
    const d = env.data;
    this.policy = {
      state: this.policy?.state ?? "running",
      reason: "",
      task: this.policy?.task ?? "",
      step: _toNumber(d.step, this.policy?.step ?? 0),
      trace_id: _toString(d.trace_id, this.policy?.trace_id ?? ""),
      planner_step_id: _toString(d.planner_step_id, this.policy?.planner_step_id ?? ""),
      canonical_action: _toString(d.canonical_action, this.policy?.canonical_action ?? ""),
      target_entity_id: _toString(d.target_entity_id, this.policy?.target_entity_id ?? ""),
      target_label: _toString(d.target_label, this.policy?.target_label ?? ""),
      receivedAt: Date.now(),
    };
  }

  private _onPolicyStatus(env: EventEnvelope): void {
    const d = env.data;
    this.policy = {
      state: _toString(d.state, this.policy?.state ?? "idle"),
      reason: _toString(d.reason, ""),
      task: _toString(d.task, this.policy?.task ?? ""),
      step: _toNumber(d.steps_completed, _toNumber(d.step, this.policy?.step ?? 0)),
      trace_id: _toString(d.trace_id, this.policy?.trace_id ?? ""),
      planner_step_id: _toString(d.planner_step_id, this.policy?.planner_step_id ?? ""),
      canonical_action: _toString(d.canonical_action, this.policy?.canonical_action ?? ""),
      target_entity_id: _toString(d.target_entity_id, this.policy?.target_entity_id ?? ""),
      target_label: _toString(d.target_label, this.policy?.target_label ?? ""),
      receivedAt: Date.now(),
    };
  }

  private _onDeadman(env: EventEnvelope): void {
    this.safety = {
      reason: "deadman_triggered",
      ageSec: typeof env.data.age_sec === "number" ? env.data.age_sec : null,
      step: null,
      receivedAt: Date.now(),
    };
    logger.warn(
      `[AinexService] deadman fired (age=${env.data.age_sec ?? "?"}s) — bridge auto-stopped`,
    );
  }

  private _onPolicyGuard(env: EventEnvelope): void {
    this.safety = {
      reason: _toString(env.data.reason, "policy_guard"),
      ageSec: typeof env.data.age_sec === "number" ? env.data.age_sec : null,
      step: typeof env.data.step === "number" ? env.data.step : null,
      receivedAt: Date.now(),
    };
  }
}
