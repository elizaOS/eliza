/** Final, authenticated resolution of ONE approved item. Never accepts model/gallery URLs. */
import { boundedFetch } from "@elizaos/cloud-services-common/transport";
import {
  type ApprovedRelayPhoto,
  parseApprovedRelayPhotos,
  RELAY_PHOTO_RESOLVE_PATH,
  type RelayPhotoResolveResponse,
} from "@elizaos/plugin-network/contract";
import { svcSign } from "@elizaos/plugin-network/svc-auth";

/** Called after the existing durable unsent claim, never by receipt-only recovery.
 * The Network service must recheck canonical review/consent/parties/files, bind the
 * provider intent to its persisted outbound item, and recheck again on retrieval.
 */
export async function resolveApprovedRelayPhotoUrls(
  approvedPhotos: ApprovedRelayPhoto[],
  id: string,
  to: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const photos = parseApprovedRelayPhotos(approvedPhotos);
  const first = photos?.[0];
  if (
    !first ||
    !photos ||
    env.NETWORK_RELAY_ENABLED !== "1" ||
    photos.some(
      (p) => p.reviewedAt > Date.now() || p.expiresAt <= Date.now(),
    ) ||
    !/^[A-Za-z0-9:._-]{1,200}$/u.test(id) ||
    !/^\+[1-9]\d{6,14}$/u.test(to)
  ) {
    throw new Error("Approved photo relay is unavailable");
  }
  const serviceUrl = env.NETWORK_SERVICE_URL;
  const serviceSecret = env.SERVICE_TURN_SECRET;
  const origin = new URL(serviceUrl ?? "");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !serviceSecret ||
    serviceSecret.length < 32
  ) {
    throw new Error("Approved photo service authority unavailable");
  }
  const body = JSON.stringify({
    id,
    deliveryId: `relay:${first.itemId}`,
    to,
    approvedPhotos: photos,
  });
  const headers = await svcSign(serviceSecret, {
    method: "POST",
    path: RELAY_PHOTO_RESOLVE_PATH,
    id,
    body,
  });
  const response = await boundedFetch(
    new URL(RELAY_PHOTO_RESOLVE_PATH, origin),
    {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", ...headers },
      body,
    },
    {
      fetchImpl,
      timeoutMs: 10_000,
      maxResponseBytes: 16 * 1024,
      invalidBoundsError: () =>
        new Error("Invalid approved photo request bounds"),
      responseTooLargeError: () =>
        new Error("Approved photo resolution too large"),
      timeoutMessage: "Approved photo resolution expired",
      cancellationMessage: "Approved photo resolution cancelled",
    },
  );
  if (!response.ok) throw new Error("Approved photo resolution refused");
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).join() !== "photos" ||
    !("photos" in result) ||
    !Array.isArray(result.photos) ||
    result.photos.length !== photos.length
  )
    throw new Error("Invalid approved photo resolution");
  return (result as RelayPhotoResolveResponse).photos.map((resolved, index) => {
    const expected = photos[index];
    if (
      !expected ||
      !resolved ||
      typeof resolved !== "object" ||
      Array.isArray(resolved) ||
      Object.keys(resolved).sort().join() !==
        "bytes,contentType,photoId,sha256,url" ||
      resolved.photoId !== expected.photoId ||
      resolved.sha256 !== expected.sha256 ||
      resolved.bytes !== expected.bytes ||
      resolved.contentType !== expected.contentType ||
      typeof resolved.url !== "string" ||
      resolved.url.length > 2048
    )
      throw new Error("Approved photo identity conflict");
    const url = new URL(resolved.url);
    const params = [...url.searchParams.keys()].sort();
    const exp = url.searchParams.get("exp");
    if (
      url.origin !== origin.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/api\/relay-photos\/deliver\/pri_[a-f0-9]{32}$/u.test(url.pathname) ||
      url.pathname !== `/api/relay-photos/deliver/${expected.itemId}` ||
      params.join() !== "exp,sig" ||
      !exp ||
      !/^[1-9]\d{0,15}$/u.test(exp) ||
      !Number.isSafeInteger(Number(exp)) ||
      Number(exp) <= Date.now() ||
      Number(exp) > expected.expiresAt ||
      !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("sig") ?? "")
    )
      throw new Error("Invalid approved photo delivery capability");
    return url.href;
  });
}
