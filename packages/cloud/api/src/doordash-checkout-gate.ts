/** Atomically claims confirmed DoorDash checkout states for one Cloud user. */

interface CheckoutClaims {
  [digest: string]: string;
}

const CLAIM_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CLAIMS = 100;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export class DoorDashCheckoutGate {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/claim"
    ) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    let digest: string | undefined;
    try {
      const body = (await request.json()) as { digest?: unknown };
      digest = typeof body.digest === "string" ? body.digest : undefined;
    } catch {
      // error-policy:J3 malformed JSON is rejected at the Durable Object boundary.
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!digest || !DIGEST_PATTERN.test(digest)) {
      return Response.json({ error: "invalid_digest" }, { status: 400 });
    }

    const now = Date.now();
    const claimed = await this.state.storage.transaction(
      async (transaction) => {
        const stored = (await transaction.get<CheckoutClaims>("claims")) ?? {};
        const retained = Object.entries(stored)
          .filter(([, createdAt]) => {
            const timestamp = Date.parse(createdAt);
            return Number.isFinite(timestamp) && now - timestamp < CLAIM_TTL_MS;
          })
          .sort(([, left], [, right]) => Date.parse(left) - Date.parse(right))
          .slice(-(MAX_CLAIMS - 1));
        const claims = Object.fromEntries(retained) as CheckoutClaims;
        if (claims[digest]) return false;
        claims[digest] = new Date(now).toISOString();
        await transaction.put("claims", claims);
        return true;
      },
    );

    return claimed
      ? Response.json({ claimed: true }, { status: 201 })
      : Response.json({ claimed: false }, { status: 409 });
  }
}
