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

export const perceptionProvider: Provider = {
  name: "AINEX_PERCEPTION",
  description:
    "Robot-side perception summary (entities detected by the bridge's camera/perception pipeline). Hands off to plugin-vision for vision-language reasoning.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<AinexService>(AinexService.serviceType);
    const perception = service?.getPerception();
    if (!service || !service.isConnected() || !perception) {
      return _disconnectedResult();
    }
    if (perception.entities.length === 0) {
      return {
        text: "AiNex perception: no entities detected.",
        values: { ainexConnected: true, entityCount: 0 },
        data: { perception },
      };
    }
    const summary = perception.entities
      .slice(0, 8)
      .map((e) => {
        const dx = e.x.toFixed(2);
        const dy = e.y.toFixed(2);
        const dz = e.z.toFixed(2);
        const dist =
          typeof e.distance === "number" ? `, distance=${e.distance.toFixed(2)}m` : "";
        return `- ${e.label} (id=${e.entity_id}, conf=${e.confidence.toFixed(2)}, rel=[${dx}, ${dy}, ${dz}]${dist})`;
      })
      .join("\n");
    return {
      text: `AiNex perception (${perception.entities.length} entities):\n${summary}`,
      values: {
        ainexConnected: true,
        entityCount: perception.entities.length,
      },
      data: { perception },
    };
  },
};
