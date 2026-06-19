import { oauthIntentsRepository } from "../../db/repositories/oauth-intents";
import { createOAuthIntentsService, type OAuthIntentsService } from "./oauth-intents";

let singleton: OAuthIntentsService | null = null;

export function getOAuthIntentsService(_env?: unknown): OAuthIntentsService {
  singleton ??= createOAuthIntentsService({ repository: oauthIntentsRepository });
  return singleton;
}

export const oauthIntentsService = new Proxy({} as OAuthIntentsService, {
  get(_target, prop: string | symbol) {
    const service = getOAuthIntentsService();
    const value = service[prop as keyof OAuthIntentsService];
    return typeof value === "function" ? value.bind(service) : value;
  },
});
