/** Routes authenticated view interactions into Chromium's foreground accessibility controller. */
import { registerPlugin } from "@capacitor/core";
import { useEffect } from "react";
import { registerViewInteractHandler } from "../components/views/view-interact-registry";
import { useAvailableViews } from "./useAvailableViews";

interface BrowserCommandBridge {
  browserCommand(
    command: Record<string, unknown>,
  ): Promise<
    { ok: true; data: unknown } | { ok: false; code: string; message: string }
  >;
}

const computerUse = registerPlugin<BrowserCommandBridge>("ComputerUse");
const supported = new Set(["snapshot", "click", "fill", "scroll", "back"]);

export function useAndroidChromiumAgentControl(): void {
  const { views } = useAvailableViews();
  const installationId = views.find(
    (view) => view.id === "browser" && (view.viewType ?? "gui") === "gui",
  )?.installationId;
  useEffect(
    () =>
      registerViewInteractHandler(
        "browser",
        "gui",
        async (capability, params) => {
          if (capability !== "browser-command")
            throw new Error(
              "Chromium supports typed browser commands; request a browser snapshot.",
            );
          const command = params?.command;
          if (!command || typeof command !== "object" || Array.isArray(command))
            throw new Error("Browser command is required.");
          const value = command as Record<string, unknown>;
          if (
            typeof value.subaction !== "string" ||
            !supported.has(value.subaction)
          )
            throw new Error(
              "Unsupported Chromium command. Use snapshot, click, fill, scroll, or back.",
            );
          if (value.id !== undefined)
            throw new Error("Server tab IDs cannot target native Chromium.");
          const reply = await computerUse.browserCommand(value);
          return reply;
        },
        installationId,
      ),
    [installationId],
  );
}
