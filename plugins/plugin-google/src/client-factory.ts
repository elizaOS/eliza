import {
  type calendar_v3,
  type docs_v1,
  type drive_v3,
  type gmail_v1,
  google,
  type meet_v2,
  type sheets_v4,
} from "googleapis";
import { MissingGoogleCredentialResolver } from "./auth.js";
import { type GoogleCapability, scopesForGoogleCapabilities } from "./scopes.js";
import {
  GOOGLE_SERVICE_NAME,
  type GoogleAccountRef,
  type GoogleAuthClient,
  type GoogleCredentialResolver,
} from "./types.js";

function mockGoogleRootUrl(): string | undefined {
  const raw = process.env.ELIZA_MOCK_GOOGLE_BASE?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!url.pathname.endsWith("/")) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  } catch {
    return raw.endsWith("/") ? raw : `${raw}/`;
  }
}

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
    return google.gmail(this.apiOptions("v1", auth));
  }

  async calendar(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ): Promise<calendar_v3.Calendar> {
    const auth = await this.resolveAuthClient(account, capabilities, reason);
    return google.calendar(this.apiOptions("v3", auth));
  }

  async drive(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ): Promise<drive_v3.Drive> {
    const auth = await this.resolveAuthClient(account, capabilities, reason);
    return google.drive(this.apiOptions("v3", auth));
  }

  async docs(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ): Promise<docs_v1.Docs> {
    const auth = await this.resolveAuthClient(account, capabilities, reason);
    return google.docs(this.apiOptions("v1", auth));
  }

  async sheets(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ): Promise<sheets_v4.Sheets> {
    const auth = await this.resolveAuthClient(account, capabilities, reason);
    return google.sheets(this.apiOptions("v4", auth));
  }

  async meet(
    account: GoogleAccountRef,
    capabilities: readonly GoogleCapability[],
    reason: string
  ): Promise<meet_v2.Meet> {
    const auth = await this.resolveAuthClient(account, capabilities, reason);
    return google.meet(this.apiOptions("v2", auth));
  }

  private apiOptions<TVersion extends string>(
    version: TVersion,
    auth: GoogleAuthClient
  ): { version: TVersion; auth: GoogleAuthClient; rootUrl?: string } {
    const rootUrl = mockGoogleRootUrl();
    return rootUrl ? { version, auth, rootUrl } : { version, auth };
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
