import type { CloudMapsRequest } from "./cloud-provider.ts";
import { MapsFailure } from "./contracts.ts";

type MapsSession = {
  sessionId: string;
  credentialId: string;
  client: { mapsRequest: CloudMapsRequest };
};
/** Capture once per provider, never migrate retained locations to a new signed-in account. */
export function captureMapsSession(
  current: () => MapsSession | null,
): CloudMapsRequest {
  const owner = current();
  const assertOwner = () => {
    const value = current();
    if (
      !owner ||
      !value ||
      value.sessionId !== owner.sessionId ||
      value.credentialId !== owner.credentialId
    )
      throw new MapsFailure(
        "unauthorized",
        "The Maps account changed. Search again after signing in.",
      );
    return value;
  };
  return async (route, signal, body) => {
    const active = assertOwner();
    signal.throwIfAborted();
    const result = await active.client.mapsRequest(route, signal, body);
    assertOwner();
    signal.throwIfAborted();
    return result;
  };
}
