import type { IAgentRuntime } from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import { BrokerAuthProvider } from "./broker";
import { EnvAuthProvider } from "./env";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";
import type { XAuthMode, XAuthProvider } from "./types";

function normalizeMode(v: string | undefined | null): XAuthMode {
  const mode = (v ?? "env").toLowerCase();
  if (mode === "env" || mode === "oauth" || mode === "broker") return mode;
  throw new Error(`Invalid X_AUTH_MODE=${v}. Expected env|oauth|broker.`);
}

export function getXAuthMode(runtime?: IAgentRuntime, state?: Record<string, unknown>): XAuthMode {
  const modeRaw = state?.X_AUTH_MODE ?? getSetting(runtime ?? null, "X_AUTH_MODE");
  const mode = typeof modeRaw === "string" ? modeRaw : undefined;
  return normalizeMode(mode ?? "env");
}

export function createXAuthProvider(
  runtime: IAgentRuntime,
  state?: Record<string, unknown>
): XAuthProvider {
  const mode = getXAuthMode(runtime, state);
  switch (mode) {
    case "env":
      return new EnvAuthProvider(runtime, state);
    case "oauth":
      return new OAuth2PKCEAuthProvider(runtime);
    case "broker":
      return new BrokerAuthProvider(runtime);
  }
}
