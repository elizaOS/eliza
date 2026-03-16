export declare function validatePath(
  commandPath: string,
  allowedDir: string,
  currentDir: string
): string | null;
export declare function isSafeCommand(command: string): boolean;
export declare function extractBaseCommand(fullCommand: string): string;
export declare function isForbiddenCommand(command: string, forbiddenCommands: string[]): boolean;
