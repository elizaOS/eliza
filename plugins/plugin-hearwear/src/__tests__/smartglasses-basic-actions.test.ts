import { describe, expect, it } from "vitest";
import { displaySmartglassesTextAction } from "../actions/display-text.ts";
import { smartglassesMicrophoneAction } from "../actions/microphone.ts";
import {
  SMARTGLASSES_SERVICE_NAME,
  SmartglassesService,
} from "../services/smartglasses-service.ts";

function runtimeWithService(service: SmartglassesService) {
  return {
    getService: (name: string) =>
      name === SMARTGLASSES_SERVICE_NAME ? service : null,
  };
}

describe("smartglasses basic actions", () => {
  it("returns display action failures when no transport can send text", async () => {
    const service = new SmartglassesService();
    const callbacks: Array<{ text?: string }> = [];

    const result = await displaySmartglassesTextAction.handler(
      runtimeWithService(service) as never,
      { content: { text: '{"text":"hello"}' } } as never,
      undefined,
      undefined,
      (message) => {
        callbacks.push(message);
        return Promise.resolve([]);
      },
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("Smartglasses display command failed");
    expect(result?.values).toMatchObject({
      error: "No smartglasses transport is configured",
    });
    expect(callbacks.at(-1)?.text).toBe(result?.text);
  });

  it("returns microphone action failures when no transport can toggle mic", async () => {
    const service = new SmartglassesService();
    const callbacks: Array<{ text?: string }> = [];

    const result = await smartglassesMicrophoneAction.handler(
      runtimeWithService(service) as never,
      { content: { text: "enable microphone" } } as never,
      undefined,
      undefined,
      (message) => {
        callbacks.push(message);
        return Promise.resolve([]);
      },
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("Smartglasses microphone command failed");
    expect(result?.values).toMatchObject({
      microphoneEnabled: true,
      error: "No smartglasses transport is configured",
    });
    expect(callbacks.at(-1)?.text).toBe(result?.text);
  });
});
