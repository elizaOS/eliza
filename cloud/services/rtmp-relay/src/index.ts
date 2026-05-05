/**
 * SRS-backed RTMP relay (optional). The Cloud API currently mints stub ingest
 * credentials in the Worker; this package holds shared types and will host the
 * control-plane client when SRS is provisioned.
 */

export interface CreateRelaySessionInput {
  readonly organizationId: string;
  readonly destinationPlatforms: readonly string[];
}

export interface RelaySessionCredentials {
  readonly sessionId: string;
  readonly streamKey: string;
  readonly ingestUrl: string;
}

export interface RtmpRelayEnv {
  readonly STREAMING_RELAY_INGEST_BASE?: string;
}

export class RtmpRelayService {
  constructor(private readonly env: RtmpRelayEnv) {}

  /**
   * Placeholder session mint — matches Worker stub until SRS HTTP API is wired.
   */
  mintStubSession(): RelaySessionCredentials {
    const base =
      this.env.STREAMING_RELAY_INGEST_BASE?.replace(/\/+$/, "") ?? "rtmp://127.0.0.1:1935/live";
    return {
      sessionId: crypto.randomUUID(),
      streamKey: crypto.randomUUID().replace(/-/g, ""),
      ingestUrl: base,
    };
  }

  closeSession(_sessionId: string): void {}
}
