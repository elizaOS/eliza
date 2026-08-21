/** Minimal Google Play consumer shell: Cloud auth, text/voice chat and history. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AndroidCloudClient,
  type AndroidCloudSession,
} from "./android-cloud-client";

export const ANDROID_CLOUD_CONVERSATION_ID_KEY =
  "eliza:android-cloud:conversation-id:v1";
const LOGIN_POLL_MS = 1_500;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const ANDROID_CLOUD_COMPOSE_EVENT = "eliza:android-cloud-compose";

export interface AndroidCloudMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface AndroidCloudAppProps {
  client?: AndroidCloudClient;
  /** The Capacitor entry should provide Browser.open or another system-browser adapter. */
  openExternal?: (url: string) => Promise<void> | void;
  closeExternal?: () => Promise<void> | void;
  voice?: AndroidCloudVoiceAdapter;
}

export interface AndroidCloudVoiceAdapter {
  requestAndStart(
    onFinalTranscript: (text: string) => void,
    onError: (error: Error) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  stop(): Promise<void>;
  speak(text: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

function defaultExternalOpen(url: string): void {
  const opened = window.open(url, "_system", "noopener,noreferrer");
  if (!opened) {
    // Deliberately NOT window.location.assign(url). That would load the Cloud
    // sign-in page inside this app's own WebView, putting a credential-entry
    // form on a surface the app controls and can read — which is exactly what
    // opening in "_system" exists to avoid. Failing here surfaces a real error
    // instead of silently downgrading to the unsafe path.
    throw new Error(
      "Unable to open the browser for sign-in. Check that a browser is installed and try again.",
    );
  }
}

export function AndroidCloudApp({
  client: clientOverride,
  openExternal = defaultExternalOpen,
  closeExternal,
  voice,
}: AndroidCloudAppProps): React.JSX.Element {
  const client = useMemo(
    () => clientOverride ?? new AndroidCloudClient(),
    [clientOverride],
  );
  const [session, setSession] = useState<AndroidCloudSession | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "signed-out" | "ready">(
    "loading",
  );
  const [messages, setMessages] = useState<AndroidCloudMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loginAbortRef = useRef<AbortController | null>(null);
  const loginAttemptRef = useRef(0);
  const voiceAbortRef = useRef<AbortController | null>(null);
  const voiceAttemptRef = useRef(0);

  const restore = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      if (!signal) setPhase("loading");
      try {
        const restored = await client.restoreSession();
        if (signal?.aborted) return;
        let storedConversationId: string | null = null;
        let restoredMessages: AndroidCloudMessage[] = [];
        let historyErrorMessage: string | null = null;
        if (restored) {
          storedConversationId =
            localStorage.getItem(ANDROID_CLOUD_CONVERSATION_ID_KEY)?.trim() ||
            null;
          if (storedConversationId) {
            try {
              restoredMessages = (
                await client.getConversationMessages(
                  restored,
                  storedConversationId,
                )
              ).slice(-100);
            } catch (historyError) {
              if (signal?.aborted) return;
              // error-policy:J4 conversation restore failure remains visible
              // while the authenticated shell stays usable for a new chat.
              historyErrorMessage = `Your previous conversation could not be restored: ${errorMessage(historyError)}`;
            }
          }
        }
        if (signal?.aborted) return;
        setSession(restored);
        if (restored) {
          setConversationId(storedConversationId);
          setMessages(restoredMessages);
          if (historyErrorMessage) setError(historyErrorMessage);
        } else {
          localStorage.removeItem(ANDROID_CLOUD_CONVERSATION_ID_KEY);
          setConversationId(null);
          setMessages([]);
        }
        setPhase(restored ? "ready" : "signed-out");
      } catch (restoreError) {
        if (signal?.aborted) return;
        // error-policy:J4 session verification failure becomes an explicit
        // signed-out error state with a retry affordance.
        setSession(null);
        setPhase("signed-out");
        setError(errorMessage(restoreError));
      }
    },
    [client],
  );

  useEffect(() => {
    void restore();
    return () => {
      loginAttemptRef.current += 1;
      loginAbortRef.current?.abort();
      abortRef.current?.abort();
      voiceAttemptRef.current += 1;
      voiceAbortRef.current?.abort();
      void voice?.stop();
    };
  }, [restore, voice]);

  useEffect(() => {
    const compose = (event: Event) => {
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text !== "string" || !text.trim()) return;
      setDraft((current) => `${current}${current ? "\n" : ""}${text.trim()}`);
    };
    window.addEventListener(ANDROID_CLOUD_COMPOSE_EVENT, compose);
    return () =>
      window.removeEventListener(ANDROID_CLOUD_COMPOSE_EVENT, compose);
  }, []);

  const signIn = useCallback(async () => {
    const attemptNumber = loginAttemptRef.current + 1;
    loginAttemptRef.current = attemptNumber;
    loginAbortRef.current?.abort();
    const controller = new AbortController();
    loginAbortRef.current = controller;
    let committedToken: string | null = null;
    setBusy(true);
    setError(null);
    try {
      const attempt = await client.beginLogin();
      await openExternal(attempt.browserUrl);
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, LOGIN_POLL_MS),
        );
        if (
          controller.signal.aborted ||
          loginAttemptRef.current !== attemptNumber
        )
          return;
        const result = await client.pollLogin(
          attempt.sessionId,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          loginAttemptRef.current !== attemptNumber
        )
          return;
        if (result.status === "pending") continue;
        if (result.status === "expired") throw new Error(result.error);
        await client.persistLogin(result.token, controller.signal);
        committedToken = result.token;
        if (
          controller.signal.aborted ||
          loginAttemptRef.current !== attemptNumber
        )
          return;
        await closeExternal?.();
        if (
          controller.signal.aborted ||
          loginAttemptRef.current !== attemptNumber
        )
          return;
        await restore(controller.signal);
        return;
      }
      throw new Error("Sign-in timed out. Please try again.");
    } catch (signInError) {
      // error-policy:J4 the sign-in boundary renders the actionable failure.
      if (
        !controller.signal.aborted &&
        loginAttemptRef.current === attemptNumber
      ) {
        setError(errorMessage(signInError));
      }
    } finally {
      if (
        committedToken &&
        (controller.signal.aborted || loginAttemptRef.current !== attemptNumber)
      ) {
        try {
          await client.discardLogin(committedToken);
        } catch (rollbackError) {
          // error-policy:J4 a secure-store rollback failure is visible instead
          // of becoming an unhandled event-handler rejection.
          setError(
            `Sign-in was cancelled, but its credential could not be removed: ${errorMessage(rollbackError)}`,
          );
        }
      }
      if (loginAttemptRef.current === attemptNumber) {
        loginAbortRef.current = null;
        setBusy(false);
      }
    }
  }, [client, closeExternal, openExternal, restore]);

  const cancelSignIn = useCallback(() => {
    loginAttemptRef.current += 1;
    loginAbortRef.current?.abort();
    loginAbortRef.current = null;
    setBusy(false);
    void closeExternal?.();
  }, [closeExternal]);

  const signOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await client.signOut();
      localStorage.removeItem(ANDROID_CLOUD_CONVERSATION_ID_KEY);
      setSession(null);
      setConversationId(null);
      setMessages([]);
      setPhase("signed-out");
    } catch (signOutError) {
      // error-policy:J4 failed logout remains visible without fabricating a
      // signed-out state that the client did not complete.
      setError(errorMessage(signOutError));
    } finally {
      setBusy(false);
    }
  }, [client]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!session || !text || busy) return;
    const userMessage: AndroidCloudMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
    };
    const assistantId = crypto.randomUUID();
    setDraft("");
    setError(null);
    setBusy(true);
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", text: "" },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let activeConversationId = conversationId;
      if (!activeConversationId) {
        activeConversationId =
          localStorage.getItem(ANDROID_CLOUD_CONVERSATION_ID_KEY)?.trim() ||
          null;
        if (!activeConversationId) {
          activeConversationId = await client.createConversation(session);
          localStorage.setItem(
            ANDROID_CLOUD_CONVERSATION_ID_KEY,
            activeConversationId,
          );
        }
        setConversationId(activeConversationId);
      }
      await client.sendChat(
        session,
        activeConversationId,
        text,
        (reply) =>
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, text: reply }
                : message,
            ),
          ),
        controller.signal,
      );
    } catch (sendError) {
      // error-policy:J4 a failed send removes the optimistic placeholder and
      // surfaces non-user-cancelled failures in the composer.
      setMessages((current) =>
        current.filter((message) => message.id !== assistantId),
      );
      if (!controller.signal.aborted) {
        setError(errorMessage(sendError));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [busy, client, conversationId, draft, session]);

  const toggleDictation = useCallback(async () => {
    if (listening) {
      voiceAttemptRef.current += 1;
      voiceAbortRef.current?.abort();
      voiceAbortRef.current = null;
      setListening(false);
      try {
        await voice?.stop();
      } catch (stopError) {
        // error-policy:J4 a native stop failure remains visible at the input.
        setError(errorMessage(stopError));
      }
      return;
    }
    if (!voice) {
      setError("Voice dictation is not available on this device.");
      return;
    }
    const attemptNumber = voiceAttemptRef.current + 1;
    voiceAttemptRef.current = attemptNumber;
    voiceAbortRef.current?.abort();
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    setError(null);
    setListening(true);
    let nativeAttemptFinished = false;
    try {
      await voice.requestAndStart(
        (value) => {
          if (
            controller.signal.aborted ||
            voiceAttemptRef.current !== attemptNumber
          )
            return;
          nativeAttemptFinished = true;
          const transcript = value.trim();
          if (transcript) {
            setDraft(
              (current) => `${current}${current ? " " : ""}${transcript}`,
            );
          }
          setListening(false);
        },
        (nativeError) => {
          if (
            controller.signal.aborted ||
            voiceAttemptRef.current !== attemptNumber
          )
            return;
          nativeAttemptFinished = true;
          setListening(false);
          setError(errorMessage(nativeError));
        },
        controller.signal,
      );
    } catch (dictationError) {
      // error-policy:J4 denied or failed dictation is visible at the input.
      if (
        !nativeAttemptFinished &&
        !controller.signal.aborted &&
        voiceAttemptRef.current === attemptNumber
      ) {
        setListening(false);
        setError(errorMessage(dictationError));
      }
    } finally {
      if (voiceAttemptRef.current === attemptNumber) {
        voiceAbortRef.current = null;
      }
    }
  }, [listening, voice]);

  const speak = useCallback(
    (text: string) => {
      if (!voice) {
        setError("Audio playback is not available on this device.");
        return;
      }
      void voice.speak(text).catch((playbackError) => {
        // error-policy:J4 playback failure is visible beside the transcript.
        setError(errorMessage(playbackError));
      });
    },
    [voice],
  );

  if (phase === "loading") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg text-txt">
        Loading Eliza…
      </main>
    );
  }

  if (phase === "signed-out") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg p-6 text-txt">
        <section className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-card p-6 text-center">
          <h1 className="text-2xl font-semibold">Eliza</h1>
          <p className="text-sm text-muted">
            Sign in securely to chat with your Eliza.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          ) : null}
          {busy ? (
            <button
              type="button"
              onClick={cancelSignIn}
              className="w-full rounded-xl border border-border px-4 py-3 font-semibold"
            >
              Cancel sign-in
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void signIn()}
              className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-accent-foreground"
            >
              Sign in
            </button>
          )}
          {error ? (
            <button
              type="button"
              onClick={() => void restore()}
              className="text-sm text-muted underline"
            >
              Retry session check
            </button>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col bg-bg text-txt">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h1 className="font-semibold">Eliza</h1>
          <p className="text-xs text-muted">{session?.identity.displayName}</p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem(ANDROID_CLOUD_CONVERSATION_ID_KEY);
              setConversationId(null);
              setMessages([]);
            }}
            className="text-sm text-muted"
          >
            New chat
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void signOut()}
            className="text-sm text-muted disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
      </header>
      <ol
        aria-live="polite"
        className="flex flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {messages.length === 0 ? (
          <li className="m-auto text-center text-sm text-muted">
            Ask Eliza anything.
          </li>
        ) : null}
        {messages.map((message) => (
          <li
            key={message.id}
            className={`max-w-[85%] rounded-2xl px-4 py-3 ${message.role === "user" ? "ml-auto bg-accent text-accent-foreground" : "mr-auto bg-card"}`}
          >
            <p className="whitespace-pre-wrap">{message.text || "Thinking…"}</p>
            {message.role === "assistant" && message.text ? (
              <button
                type="button"
                onClick={() => speak(message.text)}
                className="mt-2 text-xs text-muted underline"
              >
                Play
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {error ? (
        <p role="alert" className="px-4 pb-2 text-sm text-status-danger">
          {error}
        </p>
      ) : null}
      <form
        className="flex gap-2 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <button
          type="button"
          aria-pressed={listening}
          aria-label={listening ? "Stop dictation" : "Start dictation"}
          onClick={() => void toggleDictation()}
          className="rounded-xl border border-border px-3"
        >
          {listening ? "Stop" : "Mic"}
        </button>
        <label className="sr-only" htmlFor="android-cloud-message">
          Message Eliza
        </label>
        <textarea
          id="android-cloud-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={1}
          disabled={busy}
          className="min-h-11 flex-1 resize-none rounded-xl border border-border bg-card px-3 py-2"
          placeholder="Message Eliza"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="rounded-xl border border-border px-4"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-xl bg-accent px-4 text-accent-foreground disabled:opacity-50"
          >
            Send
          </button>
        )}
      </form>
    </main>
  );
}

export default AndroidCloudApp;
