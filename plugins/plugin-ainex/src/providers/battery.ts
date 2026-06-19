import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { AinexService } from "../service";

const FULL_MV = 12600;
const LOW_MV = 6600;

function _percent(mv: number): number {
  if (!Number.isFinite(mv) || mv <= 0) return 0;
  const range = FULL_MV - LOW_MV;
  const clamped = Math.max(LOW_MV, Math.min(FULL_MV, mv));
  return Math.round(((clamped - LOW_MV) / range) * 100);
}

export const batteryProvider: Provider = {
  name: "AINEX_BATTERY",
  description: "Robot battery voltage and charge state from the AiNex bridge.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<AinexService>(AinexService.serviceType);
    const telemetry = service?.getTelemetry();
    if (!service || !service.isConnected() || !telemetry) {
      return {
        text: "(ainex not connected)",
        values: { ainexConnected: false },
        data: {},
      };
    }
    const mv = telemetry.battery_mv;
    const pct = _percent(mv);
    const low = mv <= LOW_MV;
    return {
      text: low
        ? `AiNex battery: ${mv} mV (${pct}%) — LOW, swap soon.`
        : `AiNex battery: ${mv} mV (${pct}%).`,
      values: {
        ainexConnected: true,
        batteryMv: mv,
        batteryPercent: pct,
        batteryLow: low,
      },
      data: { battery: { mv, percent: pct, low } },
    };
  },
};
