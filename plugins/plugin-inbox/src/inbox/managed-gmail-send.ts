/** Prepared sends only: no provider credentials, direct-send endpoint, or retry loop. */
import { managedGmailHostTransport } from "./managed-gmail-transport.ts";
export type ManagedSendContent = {
  to: string[];
  subject: string;
  bodyText: string;
};
export type ManagedSendReceipt = {
  requestId: string;
  kind: "send";
  state:
    | "prepared"
    | "dispatched"
    | "succeeded"
    | "rejected"
    | "outcome-unknown";
  reviewDigest: string;
  providerResult: Record<string, unknown> | null;
};
const idPattern = /^alpha-gmail-send:[a-f0-9]{64}:([a-f0-9-]{36})$/;
function receipt(value: unknown, id: string): ManagedSendReceipt {
  const match = idPattern.exec(id),
    row = value as ManagedSendReceipt | null;
  if (
    !match ||
    !row ||
    row.requestId !== match[1] ||
    row.kind !== "send" ||
    ![
      "prepared",
      "dispatched",
      "succeeded",
      "rejected",
      "outcome-unknown",
    ].includes(row.state) ||
    !/^[a-f0-9]{64}$/.test(row.reviewDigest) ||
    (row.state === "succeeded"
      ? !row.providerResult ||
        typeof row.providerResult !== "object" ||
        Array.isArray(row.providerResult)
      : row.providerResult !== null)
  )
    throw Error(
      "The send receipt could not be verified. Do not send this email again.",
    );
  return row;
}
export function managedGmailSender(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  const call = managedGmailHostTransport(
    env.ELIZA_MANAGED_GMAIL_SEND_BROKER,
    env.ELIZA_API_TOKEN,
    request,
  );
  if (!call) return undefined;
  return {
    async prepare(content: ManagedSendContent) {
      const requestId = crypto.randomUUID();
      const result = (
        await call({ send: { operation: "prepare", requestId, ...content } })
      ).send as Record<string, unknown> | undefined;
      if (
        !result ||
        typeof result.id !== "string" ||
        !idPattern.test(result.id) ||
        !result.id.endsWith(":" + requestId)
      )
        throw Error("No verified email review was prepared. Nothing was sent.");
      const prepared = receipt(result.receipt, result.id);
      if (
        prepared.state !== "prepared" ||
        result.reviewDigest !== prepared.reviewDigest
      )
        throw Error("No verified email review was prepared. Nothing was sent.");
      const review = result.review as Record<string, unknown> | undefined;
      if (
        !review ||
        typeof review.from !== "string" ||
        !review.from ||
        review.subject !== content.subject ||
        review.bodyText !== content.bodyText ||
        JSON.stringify(review.to) !== JSON.stringify(content.to)
      )
        throw Error(
          "The provider review does not match this email. Nothing was sent.",
        );
      return {
        id: result.id,
        reviewDigest: prepared.reviewDigest,
        from: review.from,
      };
    },
    async dispatch(
      id: string,
      reviewDigest: string,
      content: ManagedSendContent,
    ) {
      if (!idPattern.test(id) || !/^[a-f0-9]{64}$/.test(reviewDigest))
        throw Error("Select a prepared email review.");
      const result = await call({
        send: { operation: "dispatch", id, reviewDigest, ...content },
      });
      const saved = receipt(result.send, id);
      if (saved.reviewDigest !== reviewDigest)
        throw Error(
          "The email review changed. Check its receipt before retrying.",
        );
      return saved;
    },
    async receipt(id: string) {
      if (!idPattern.test(id))
        throw Error("Select an exact email send receipt.");
      return receipt(
        (await call({ send: { operation: "receipt", id } })).send,
        id,
      );
    },
  };
}
