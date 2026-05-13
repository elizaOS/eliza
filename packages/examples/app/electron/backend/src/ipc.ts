import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import {
  getGreetingText,
  getHistory,
  resetConversation,
  sendMessage,
} from "./runtimeManager";
import type { AppConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

function getDataDir(): string {
  const dir = join(app.getPath("userData"), "eliza-localdb");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeConfig(config: AppConfig | undefined): AppConfig {
  return config ?? DEFAULT_CONFIG;
}

export function registerChatIpc(): void {
  ipcMain.handle("chat:getGreeting", async (_evt, config?: AppConfig) => {
    return getGreetingText(normalizeConfig(config));
  });

  ipcMain.handle("chat:getHistory", async (_evt, config?: AppConfig) => {
    return await getHistory(normalizeConfig(config), getDataDir());
  });

  ipcMain.handle("chat:reset", async (_evt, config?: AppConfig) => {
    await resetConversation(normalizeConfig(config), getDataDir());
  });

  ipcMain.handle(
    "chat:sendMessage",
    async (_evt, config: AppConfig | undefined, text: string) => {
      const t = typeof text === "string" ? text.trim() : "";
      if (!t) throw new Error("Missing text");
      return await sendMessage(normalizeConfig(config), t, getDataDir());
    },
  );
}
