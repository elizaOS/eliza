import { type calendar_v3, type drive_v3, type gmail_v1, google, type meet_v2 } from "googleapis";
import { MissingGoogleCredentialResolver } from "./auth.js";
import { type GoogleCapability, scopesForGoogleCapabilities } from "./scopes.js";
import {
  GOOGLE_SERVICE_NAME,
  type GoogleAccountRef,
  type GoogleCredentialResolver,
} from "./types.js";

export class GoogleApiClientFactory {
  constructor(
    private credentialResolver: GoogleCredentialResolver = new MissingGoogleCredentialResolver()
  ) {}

  setCredentialResolver(credentialResolver: GoogleCredentialResolver): void {
    this.credentialResolver = credentialResolver;
  }

  async gmail(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ): Promise<gmail_v1.Gmail> {
    const auth = await this.resolveAuthClient(account, capabilities, reason);
    return google.gmail({ version: "v1", auth });
  }

  async calendar(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ): Promise<calendar_v3.Calendar> {
    const auth = await this.resolveAuthClient(account, capabilities, reason);
    return google.calendar({ version: "v3", auth });
  }

  async drive(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ): Promise<drive_v3.Drive> {
    const auth = await this.resolveAuthClient(account, capabilities, reason);
    return google.drive({ version: "v3", auth });
  }

  async meet(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ): Promise<meet_v2.Meet> {
    const auth = await this.resolveAuthClient(account, capabilities, reason);
    return google.meet({ version: "v2", auth });
  }

  private async resolveAuthClient(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ) {
    return this.credentialResolver.getAuthClient({
      provider: GOOGLE_SERVICE_NAME,
      accountId: account.accountId,
      capabilities,
      scopes: scopesForGoogleCapabilities(capabilities),
      reason,
    });
  }
}
