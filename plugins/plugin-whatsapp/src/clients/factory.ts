/**
 * Selects the transport client for a resolved config: a BaileysClient when the
 * detected auth method is Baileys, otherwise the Cloud API WhatsAppClient. The
 * single seam behind which the rest of the connector stays transport-agnostic.
 */
import { WhatsAppClient } from "../client";
import type { BaileysConfig, CloudAPIConfig, WhatsAppConfig } from "../types";
import { detectAuthMethod } from "../utils/config-detector";
import { BaileysClient } from "./baileys-client";
import type { IWhatsAppClient } from "./interface";

export const ClientFactory = {
  create(config: WhatsAppConfig): IWhatsAppClient {
    const authMethod = detectAuthMethod(config);
    if (authMethod === "baileys") {
      return new BaileysClient(config as BaileysConfig);
    }
    return new WhatsAppClient(config as CloudAPIConfig);
  },
};
