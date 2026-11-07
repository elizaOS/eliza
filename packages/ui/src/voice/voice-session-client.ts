/** App compatibility entry. Other hosts supply their own fetch through the public voice-session client. */
import {
  createVoiceSessionClient as createHostVoiceSessionClient,
  type VoiceSessionClientOptions as HostVoiceSessionClientOptions,
  type VoiceSessionClient,
} from "./voice-session-client-core";

export * from "./voice-session-client-core";

/** The app retains its existing selected-runtime transport when no fetch is supplied. */
export type VoiceSessionClientOptions = Omit<
  HostVoiceSessionClientOptions,
  "fetch"
> & {
  fetch?: HostVoiceSessionClientOptions["fetch"];
};

export function createVoiceSessionClient(
  options: VoiceSessionClientOptions,
): VoiceSessionClient {
  return createHostVoiceSessionClient({
    ...options,
    fetch:
      options.fetch ??
      (async (url, init) => {
        const { fetchVoiceSession } = await import("./voice-session-fetch");
        return fetchVoiceSession(url, init);
      }),
  });
}
