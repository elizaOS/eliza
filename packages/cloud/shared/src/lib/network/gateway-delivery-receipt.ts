/** Only a connector's complete, request-bound acceptance may reach Network history. */
export interface AcceptedNetworkGatewayReceipt {
  idempotencyKey: string;
  acceptedAt: string;
  providerMessageIds: string[];
  replayed: boolean;
}
export function acceptedNetworkGatewayReceipt(
  status: number,
  value: unknown,
  expectedKey: string,
): AcceptedNetworkGatewayReceipt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Record<string, unknown>;
  if (
    status !== 200 ||
    receipt.success !== true ||
    receipt.idempotencyKey !== expectedKey ||
    typeof receipt.acceptedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.acceptedAt)) ||
    !Array.isArray(receipt.providerMessageIds) ||
    receipt.providerMessageIds.length === 0 ||
    !receipt.providerMessageIds.every((id) => typeof id === "string" && id.trim()) ||
    new Set(receipt.providerMessageIds).size !== receipt.providerMessageIds.length
  )
    return undefined;
  return {
    idempotencyKey: expectedKey,
    acceptedAt: receipt.acceptedAt,
    providerMessageIds: receipt.providerMessageIds as string[],
    replayed: receipt.replayed === true,
  };
}
