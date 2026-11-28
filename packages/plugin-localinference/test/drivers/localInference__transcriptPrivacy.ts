// spec/localInference/transcriptPrivacy.md, "Story: Share a transcript only as its consent allows"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/localInference__transcriptPrivacy.conformance.ts";
import type { Event, TranscriptPrivacy } from "../../gen/localInference__transcriptPrivacy.ts";
import {
  openTranscriptPrivacySession,
  type TranscriptPrivacySession,
} from "../../src/index.vibe";

const sessions = new Map<string, TranscriptPrivacySession>();

async function sessionOf(key: string): Promise<TranscriptPrivacySession> {
  let session = sessions.get(key);
  if (!session) {
    session = await Effect.runPromise(openTranscriptPrivacySession(key));
    sessions.set(key, session);
  }
  return session;
}

export const driver: Driver & AsyncDisposable = {
  reset() {
    sessions.clear();
  },

  async dispatch(key: string, event: Event) {
    const session = await sessionOf(key);
    const work =
      event.type === "recordConsent"
        ? session.recordConsent(event.consent)
        : event.type === "redactTranscript"
          ? session.redact(event.requester, {
              detailsFound: event.detailsFound,
              audioVerified: event.audioVerified,
            })
          : event.type === "shareTranscript"
            ? session.share(event.requester, event.grantee, event.mode, {
                detailsFound: event.detailsFound,
                audioVerified: event.audioVerified,
              })
            : session.redactForAll(event.requester, {
                detailsFound: event.detailsFound,
                audioVerified: event.audioVerified,
              });
    return Effect.runPromise(
      Effect.match(work, {
        onFailure: () => "refused" as const,
        onSuccess: () => "accepted" as const,
      }),
    );
  },

  async observe(key: string): Promise<TranscriptPrivacy> {
    const session = await sessionOf(key);
    return Effect.runPromise(session.state());
  },

  [Symbol.asyncDispose]() {
    sessions.clear();
    return Promise.resolve();
  },
};

export const options: Options = { keys: ["a", "b"], walks: 20, steps: 20 };
