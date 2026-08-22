/** Atomically claims confirmed DoorDash checkout states for one Cloud user. */

interface PendingCheckout {
  readonly createdAt: string;
  readonly status: "pending";
}

interface CompletedCheckout {
  readonly createdAt: string;
  readonly status: "completed";
  readonly receipt: Record<string, unknown>;
}

type CheckoutRecord = PendingCheckout | CompletedCheckout;

interface CheckoutClaims {
  [digest: string]: CheckoutRecord | string;
}

const CLAIM_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CLAIMS = 100;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export class DoorDashCheckoutGate {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      !["/claim", "/complete"].includes(pathname)
    ) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    let digest: string | undefined;
    let receipt: Record<string, unknown> | undefined;
    try {
      const body = (await request.json()) as {
        digest?: unknown;
        receipt?: unknown;
      };
      digest = typeof body.digest === "string" ? body.digest : undefined;
      receipt =
        body.receipt !== null &&
        typeof body.receipt === "object" &&
        !Array.isArray(body.receipt)
          ? (body.receipt as Record<string, unknown>)
          : undefined;
    } catch {
      // error-policy:J3 malformed JSON is rejected at the Durable Object boundary.
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!digest || !DIGEST_PATTERN.test(digest)) {
      return Response.json({ error: "invalid_digest" }, { status: 400 });
    }
    if (
      pathname === "/complete" &&
      (receipt?.success !== true ||
        typeof receipt.orderId !== "string" ||
        receipt.orderId.trim().length === 0 ||
        /^order-\d+$/i.test(receipt.orderId.trim()))
    ) {
      return Response.json({ error: "invalid_receipt" }, { status: 400 });
    }

    const now = Date.now();
    const outcome = await this.state.storage.transaction(
      async (transaction) => {
        const stored = (await transaction.get<CheckoutClaims>("claims")) ?? {};
        const retained = Object.entries(stored)
          .map(
            ([key, value]) =>
              [
                key,
                typeof value === "string"
                  ? ({
                      createdAt: value,
                      status: "pending",
                    } satisfies PendingCheckout)
                  : value,
              ] as const,
          )
          .filter(([, record]) => {
            const createdAt = record.createdAt;
            const timestamp = Date.parse(createdAt);
            return Number.isFinite(timestamp) && now - timestamp < CLAIM_TTL_MS;
          })
          .sort(
            ([, left], [, right]) =>
              Date.parse(left.createdAt) - Date.parse(right.createdAt),
          )
          .slice(-MAX_CLAIMS);
        const claims = Object.fromEntries(retained) as Record<
          string,
          CheckoutRecord
        >;

        const existing = claims[digest];
        if (pathname === "/claim") {
          if (existing) {
            return existing.status === "completed"
              ? { kind: "completed" as const, receipt: existing.receipt }
              : { kind: "pending" as const };
          }
          if (retained.length >= MAX_CLAIMS) {
            delete claims[retained[0][0]];
          }
          claims[digest] = {
            createdAt: new Date(now).toISOString(),
            status: "pending",
          };
          await transaction.put("claims", claims);
          return { kind: "claimed" as const };
        }

        if (!existing) return { kind: "missing" as const };
        if (existing.status === "completed") {
          return { kind: "completed" as const, receipt: existing.receipt };
        }
        claims[digest] = {
          createdAt: existing.createdAt,
          status: "completed",
          receipt: receipt as Record<string, unknown>,
        };
        await transaction.put("claims", claims);
        return { kind: "completed" as const, receipt };
      },
    );

    if (outcome.kind === "claimed") {
      return Response.json({ claimed: true }, { status: 201 });
    }
    if (outcome.kind === "completed") {
      return Response.json(
        { claimed: false, completed: true, receipt: outcome.receipt },
        { status: 200 },
      );
    }
    return Response.json({ claimed: false, completed: false }, { status: 409 });
  }
}
