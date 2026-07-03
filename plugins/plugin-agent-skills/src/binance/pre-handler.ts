/**
 * Binance skill chat pre-handler.
 *
 * Wraps {@link runDirectBinanceSkillDispatch} as a generic {@link ChatPreHandler}
 * so the host chat loop can drain it — alongside any other plugin's pre-handlers
 * — before normal action processing, without knowing anything about Binance.
 */

import type { ChatPreHandler } from "@elizaos/core";
import { runDirectBinanceSkillDispatch } from "./direct-dispatch";

export const binanceSkillPreHandler: ChatPreHandler = {
  id: "binance-skill-direct-dispatch",
  priority: 100,
  async tryHandle(ctx) {
    const responseText = await runDirectBinanceSkillDispatch(
      ctx.runtime,
      ctx.message,
      ctx.appendText,
      ctx.replaceText,
    );
    return responseText ? { responseText } : null;
  },
};
