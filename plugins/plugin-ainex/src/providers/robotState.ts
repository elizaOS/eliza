import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { AinexService } from "../service";

function _disconnectedResult(): ProviderResult {
  return {
    text: "(ainex not connected)",
    values: { ainexConnected: false },
    data: {},
  };
}

export const robotStateProvider: Provider = {
  name: "AINEX_ROBOT_STATE",
  description:
    "Current robot pose, IMU orientation, and walk-controller state from the AiNex bridge.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<AinexService>(AinexService.serviceType);
    const telemetry = service?.getTelemetry();
    if (!service || !service.isConnected() || !telemetry) {
      return _disconnectedResult();
    }
    const lines = [
      `walking: ${telemetry.is_walking ? "yes" : "no"}`,
      `velocity: x=${telemetry.walk_x.toFixed(3)} y=${telemetry.walk_y.toFixed(3)} yaw=${telemetry.walk_yaw.toFixed(2)}`,
      `gait: speed=${telemetry.walk_speed} height=${telemetry.walk_height.toFixed(3)}m`,
      `imu: roll=${telemetry.imu_roll.toFixed(3)} pitch=${telemetry.imu_pitch.toFixed(3)}`,
      `head: pan=${telemetry.head_pan.toFixed(2)} tilt=${telemetry.head_tilt.toFixed(2)}`,
    ];
    return {
      text: `AiNex robot state:\n${lines.join("\n")}`,
      values: {
        ainexConnected: true,
        isWalking: telemetry.is_walking,
        walkX: telemetry.walk_x,
        walkY: telemetry.walk_y,
        walkYaw: telemetry.walk_yaw,
      },
      data: { telemetry },
    };
  },
};
