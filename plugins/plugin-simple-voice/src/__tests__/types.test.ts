import { describe, expect, it } from "vitest";
import { SamTTSService, simpleVoicePlugin } from "../index";
import { SPEAK_ACTION_NAME, TTS_SERVICE_TYPE } from "../types";

describe("simple voice registration", () => {
  it("registers a single speak action", () => {
    const actionNames = simpleVoicePlugin.actions?.map((action) => action.name);

    expect(actionNames).toEqual([SPEAK_ACTION_NAME]);
  });

  it("registers a single SAM service", () => {
    const serviceTypes = simpleVoicePlugin.services?.map(
      (service) => service.serviceType,
    );

    expect(serviceTypes).toEqual([TTS_SERVICE_TYPE]);
    expect(simpleVoicePlugin.services).toEqual([SamTTSService]);
  });

  it("exposes the service type on the class", () => {
    expect(SamTTSService.serviceType).toBe(TTS_SERVICE_TYPE);
  });
});
