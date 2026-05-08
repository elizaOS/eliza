import type { IAgentRuntime } from "@elizaos/core";
import type { TwitterClientState } from "../../types";
import { getSetting } from "../../utils/settings";
import { EnvAuthProvider } from "./env";
import { OAuth2PKCEAuthProvider } from "./oauth2-pkce";
import type { TwitterAuthMode, TwitterAuthProvider } from "./types";

function normalizeMode(v: string | undefined | null): TwitterAuthMode {
  const mode = (v ?? "env").toLowerCase();
  if (mode === "env" || mode === "oauth") return mode;
  throw new Error(`Invalid TWITTER_AUTH_MODE=${v}. Expected env|oauth.`);
}

export function getTwitterAuthMode(
  runtime?: IAgentRuntime,
  state?: TwitterClientState,
): TwitterAuthMode {
  return normalizeMode(
    state?.TWITTER_AUTH_MODE ??
      getSetting(runtime ?? null, "TWITTER_AUTH_MODE") ??
      "env",
  );
}

export function createTwitterAuthProvider(
  runtime: IAgentRuntime,
  state?: TwitterClientState,
): TwitterAuthProvider {
  const mode = getTwitterAuthMode(runtime, state);
  switch (mode) {
    case "env":
      return new EnvAuthProvider(runtime, state);
    case "oauth":
      return new OAuth2PKCEAuthProvider(runtime);
  }
}
