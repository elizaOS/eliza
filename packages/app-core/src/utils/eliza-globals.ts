export type ElizaWindow = Window & {
  __ELIZA_API_BASE__?: string;
  __ELIZA_API_TOKEN__?: string;
};

function getElizaWindow(): ElizaWindow | null {
  return typeof window === "undefined" ? null : (window as ElizaWindow);
}

export function getElizaApiBase(): string | undefined {
  return getElizaWindow()?.__ELIZA_API_BASE__;
}

export function getElizaApiToken(): string | undefined {
  return getElizaWindow()?.__ELIZA_API_TOKEN__;
}

export function setElizaApiBase(value: string): void {
  const elizaWindow = getElizaWindow();
  if (elizaWindow) {
    elizaWindow.__ELIZA_API_BASE__ = value;
  }
}

export function clearElizaApiBase(): void {
  const elizaWindow = getElizaWindow();
  if (elizaWindow) {
    delete elizaWindow.__ELIZA_API_BASE__;
  }
}

export function setElizaApiToken(value: string): void {
  const elizaWindow = getElizaWindow();
  if (elizaWindow) {
    elizaWindow.__ELIZA_API_TOKEN__ = value;
  }
}

export function clearElizaApiToken(): void {
  const elizaWindow = getElizaWindow();
  if (elizaWindow) {
    delete elizaWindow.__ELIZA_API_TOKEN__;
  }
}
