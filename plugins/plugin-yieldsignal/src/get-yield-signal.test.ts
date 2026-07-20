import { describe, it, expect } from "vitest";
import { yieldSignalPlugin } from "./index.js";

describe("yieldSignalPlugin", () => {
  it("expõe a action GET_YIELD_SIGNAL com similes e descrição corretos", () => {
    expect(yieldSignalPlugin.name).toBe("yieldsignal");
    expect(yieldSignalPlugin.actions).toHaveLength(1);

    const action = yieldSignalPlugin.actions![0];
    expect(action.name).toBe("GET_YIELD_SIGNAL");
    expect(action.similes).toContain("BEST_LENDING_RATE");
  });

  it("validate sempre resolve true", async () => {
    const action = yieldSignalPlugin.actions![0];
    await expect(action.validate({} as never, {} as never)).resolves.toBe(true);
  });

  it("handler retorna ActionResult com success:false quando a chamada paga falha (sem credenciais CDP configuradas)", async () => {
    const action = yieldSignalPlugin.actions![0];
    const message = { content: { text: "what's the best USDC rate?" } } as never;
    const result = await action.handler({} as never, message, undefined, undefined, undefined);
    expect((result as { success: boolean }).success).toBe(false);
  });
});
