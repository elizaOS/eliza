import type { IAgentRuntime } from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import type { TwitterAuthMode, TwitterAuthProvider } from "./types";
import { EnvAuthProvider } from "./env";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";
import { BrokerAuthProvider } from "./broker";

function normalizeMode(v: string | undefined | null): TwitterAuthMode {
  const mode = (v ?? "env").toLowerCase();
  if (mode === "env" || mode === "oauth" || mode === "broker") return mode;
  throw new Error(`Invalid TWITTER_AUTH_MODE=${v}. Expected env|oauth|broker.`);
}

export function getTwitterAuthMode(runtime?: IAgentRuntime, state?: any): TwitterAuthMode {
  return normalizeMode(
    state?.TWITTER_AUTH_MODE ?? getSetting(runtime ?? null, "TWITTER_AUTH_MODE") ?? "env",
  );
}

export function createTwitterAuthProvider(
  runtime: IAgentRuntime,
  state?: any,
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

