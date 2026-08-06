import * as path from "node:path";

export interface TelegramHeadlessBridgePaths {
  logFile: string;
  pairCodeFile: string;
}

export interface TelegramHeadlessBridgePathOptions {
  logFile?: string;
  pairCodeFile?: string;
}

export function resolveTelegramHeadlessBridgePaths(
  cwd: string,
  options: TelegramHeadlessBridgePathOptions = {},
): TelegramHeadlessBridgePaths {
  return {
    logFile: path.resolve(cwd, options.logFile ?? "telegram-remote-bridge.log"),
    pairCodeFile: path.resolve(cwd, options.pairCodeFile ?? "telegram-pair-code.txt"),
  };
}
