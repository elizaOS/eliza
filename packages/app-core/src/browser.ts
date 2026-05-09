export * from "@elizaos/ui";

export type CompatRuntimeState = {
  current: unknown;
  pendingAgentName?: string | null;
  pendingRestartReasons?: string[];
};

export function sendJson(
  _res: unknown,
  _status: number,
  _body: unknown,
): void {}

export function sendJsonError(
  _res: unknown,
  _status: number,
  _message: string,
): void {}

export async function ensureRouteAuthorized(): Promise<boolean> {
  return false;
}

export async function ensureCompatApiAuthorized(): Promise<boolean> {
  return false;
}

export async function readCompatJsonBody(): Promise<unknown> {
  return null;
}

export function sharedVault(): never {
  throw new Error("sharedVault is server-only");
}
