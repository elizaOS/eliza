/** Short internal subscriptions to the existing organization revocation fence.
 * A lost socket retires its speech session; no poll or database read is needed.
 */
import type { InferenceCredentialCheck } from "@elizaos/cloud-shared/lib/services/inference-credential-revocation";

export interface SpeechRevocationIdentity {
  organizationId: string;
  credential: InferenceCredentialCheck;
  expiresAt: number;
}

export class SpeechRevocationRegistry {
  private readonly subscriptions = new Map<
    WebSocket,
    SpeechRevocationIdentity
  >();

  constructor(
    private readonly authorize: (
      credential: InferenceCredentialCheck & { organizationId: string },
    ) => Promise<Response | null>,
  ) {}

  async subscribe(request: Request): Promise<Response> {
    const raw = request.headers.get("X-Eliza-Speech-Identity");
    if (!raw || raw.length > 4096)
      return new Response("Invalid speech identity", { status: 400 });
    let identity: SpeechRevocationIdentity;
    try {
      identity = JSON.parse(raw) as SpeechRevocationIdentity;
    } catch {
      return new Response("Invalid speech identity", { status: 400 });
    }
    if (
      !identity ||
      !identity.credential ||
      !["api_key", "steward_session"].includes(identity.credential.kind) ||
      !Number.isSafeInteger(identity.expiresAt) ||
      identity.expiresAt <= Date.now() ||
      identity.expiresAt > Date.now() + 65000 ||
      (identity.credential.kind === "api_key" &&
        identity.credential.expiresAt != null &&
        identity.credential.expiresAt <= Date.now())
    )
      return new Response("Invalid speech identity", { status: 400 });
    const denial = await this.authorize({
      ...identity.credential,
      organizationId: identity.organizationId,
    });
    if (denial) return denial;
    if (this.subscriptions.size >= 2048)
      return new Response("Speech subscription capacity reached", {
        status: 503,
      });
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.subscriptions.set(server, identity);
    const expiresAt = Math.min(
      identity.expiresAt,
      identity.credential.kind === "api_key" &&
        typeof identity.credential.expiresAt === "number"
        ? identity.credential.expiresAt
        : identity.expiresAt,
    );
    const timer = setTimeout(() => {
      this.subscriptions.delete(server);
      server.close(1000, "Speech identity expired");
    }, expiresAt - Date.now());
    const closed = () => {
      clearTimeout(timer);
      this.subscriptions.delete(server);
    };
    server.addEventListener("close", closed);
    server.addEventListener("error", closed);
    server.addEventListener("message", () =>
      server.close(1008, "No client messages"),
    );
    server.send("ready");
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  revoke(matches: (identity: SpeechRevocationIdentity) => boolean): void {
    for (const [socket, identity] of this.subscriptions) {
      if (!matches(identity)) continue;
      this.subscriptions.delete(socket);
      socket.close(1008, "Speech identity revoked");
    }
  }
}
