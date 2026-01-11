import type { IAgentRuntime } from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import { BrokerAuthProvider } from "./broker";
import { EnvAuthProvider } from "./env";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";
import type { TwitterAuthMode, TwitterAuthProvider } from "./types";

function normalizeMode(v: string | undefined | null): TwitterAuthMode {
  const mode = (v ?? "env").toLowerCase();
  if (mode === "env" || mode === "oauth" || mode === "broker") return mode;
  throw new Error(`Invalid TWITTER_AUTH_MODE=${v}. Expected env|oauth|broker.`);
}

export function getTwitterAuthMode(
  runtime?: IAgentRuntime,
  state?: Record<string, unknown>
): TwitterAuthMode {
  const modeRaw = state?.TWITTER_AUTH_MODE ?? getSetting(runtime ?? null, "TWITTER_AUTH_MODE");
  const mode = typeof modeRaw === "string" ? modeRaw : undefined;
  return normalizeMode(mode ?? "env");
}

export function createTwitterAuthProvider(
  runtime: IAgentRuntime,
  state?: Record<string, unknown>
): TwitterAuthProvider {
  const mode = getTwitterAuthMode(runtime, state);
  switch (mode) {
    case "env":
      return new EnvAuthProvider(runtime, state);
    case "oauth":
      return new OAuth2PKCEAuthProvider(runtime);
    case "broker":
      return new BrokerAuthProvider(runtime);
  }
}
