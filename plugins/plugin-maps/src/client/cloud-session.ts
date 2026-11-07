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
      value.credentialId !== owner.credentialId ||
      value.client !== owner.client
    )
      throw new MapsFailure(
        "unauthorized",
        "The Maps account changed. Search again after signing in.",
      );
  };
  return async (route, signal, body) => {
    assertOwner();
    signal.throwIfAborted();
    if (!owner)
      throw new MapsFailure("unauthorized", "Sign in to Cloud to use Maps.");
    const result = await owner.client.mapsRequest(route, signal, body);
    assertOwner();
    signal.throwIfAborted();
    return result;
  };
}
