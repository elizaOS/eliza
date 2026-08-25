/** Minimal Google Play consumer shell: Cloud auth, text/voice chat and history. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  AndroidCloudClient,
  type AndroidCloudGoogleIdentityAdapter,
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
  googleIdentity?: AndroidCloudGoogleIdentityAdapter;
  voice?: AndroidCloudVoiceAdapter;
}

export interface AndroidCloudVoiceAdapter {
  requestAndStart(onFinalTranscript: (text: string) => void): Promise<void>;
  stop(): Promise<void>;
  speak(text: string): Promise<void>;
}

type AndroidCloudAuthFlow = "browser" | "google";

// Google's pre-approved 180x40 neutral Android/Web asset keeps the logo,
// typography, and padding tied to the current verification requirements.
const GOOGLE_SIGN_IN_NEUTRAL_ASSET = `data:image/png;base64,${[
  "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",
  "5Y8AXiyycJhDJw8AAAAASUVORK5CYII=",
].join("")}`;

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

function isGoogleSignInCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && error.code === "GOOGLE_SIGN_IN_CANCELLED";
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
  googleIdentity,
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
  const [authFlow, setAuthFlow] = useState<AndroidCloudAuthFlow | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrySessionAvailable, setRetrySessionAvailable] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const authAbortRef = useRef<AbortController | null>(null);
  const loginAttemptRef = useRef(0);

  const restore = useCallback(async () => {
    setError(null);
    setRetrySessionAvailable(false);
    setPhase("loading");
    try {
      const restored = await client.restoreSession();
      setSession(restored);
      if (restored) {
        const storedConversationId = localStorage
          .getItem(ANDROID_CLOUD_CONVERSATION_ID_KEY)
          ?.trim();
        if (storedConversationId) {
          setConversationId(storedConversationId);
          try {
            const restoredMessages = await client.getConversationMessages(
              restored,
              storedConversationId,
            );
            setMessages(restoredMessages.slice(-100));
          } catch (historyError) {
            // error-policy:J4 conversation restore failure remains visible
            // while the authenticated shell stays usable for a new chat.
            setError(
              `Your previous conversation could not be restored: ${errorMessage(historyError)}`,
            );
          }
        }
      } else {
        localStorage.removeItem(ANDROID_CLOUD_CONVERSATION_ID_KEY);
        setConversationId(null);
        setMessages([]);
      }
      setPhase(restored ? "ready" : "signed-out");
    } catch (restoreError) {
      // error-policy:J4 session verification failure becomes an explicit
      // signed-out error state with a retry affordance.
      setSession(null);
      setPhase("signed-out");
      setError(errorMessage(restoreError));
      setRetrySessionAvailable(true);
    }
  }, [client]);

  useEffect(() => {
    void restore();
    return () => {
      loginAttemptRef.current += 1;
      abortRef.current?.abort();
      authAbortRef.current?.abort();
      if (authAbortRef.current) void googleIdentity?.cancel();
      void voice?.stop();
    };
  }, [googleIdentity, restore, voice]);

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
    setBusy(true);
    setAuthFlow("browser");
    setError(null);
    setRetrySessionAvailable(false);
    try {
      const attempt = await client.beginLogin();
      await openExternal(attempt.browserUrl);
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, LOGIN_POLL_MS),
        );
        if (loginAttemptRef.current !== attemptNumber) return;
        const result = await client.pollLogin(attempt.sessionId);
        if (result.status === "pending") continue;
        if (result.status === "expired") throw new Error(result.error);
        await closeExternal?.();
        await restore();
        return;
      }
      throw new Error("Sign-in timed out. Please try again.");
    } catch (signInError) {
      // error-policy:J4 the sign-in boundary renders the actionable failure.
      if (loginAttemptRef.current === attemptNumber) {
        setError(errorMessage(signInError));
      }
    } finally {
      if (loginAttemptRef.current === attemptNumber) {
        setBusy(false);
        setAuthFlow(null);
      }
    }
  }, [client, closeExternal, openExternal, restore]);

  const signInWithGoogle = useCallback(async () => {
    if (!googleIdentity) {
      setError("Google sign-in is not available on this device.");
      return;
    }
    const attemptNumber = loginAttemptRef.current + 1;
    loginAttemptRef.current = attemptNumber;
    setBusy(true);
    setAuthFlow("google");
    setError(null);
    setRetrySessionAvailable(false);
    const controller = new AbortController();
    authAbortRef.current = controller;
    try {
      await client.signInWithGoogle(googleIdentity, controller.signal);
      if (loginAttemptRef.current !== attemptNumber) return;
      await restore();
    } catch (signInError) {
      // error-policy:J4 native identity failures remain visible and recoverable.
      if (
        loginAttemptRef.current === attemptNumber &&
        !isGoogleSignInCancellation(signInError)
      ) {
        setError(errorMessage(signInError));
      }
    } finally {
      if (loginAttemptRef.current === attemptNumber) {
        setBusy(false);
        setAuthFlow(null);
      }
      if (authAbortRef.current === controller) authAbortRef.current = null;
    }
  }, [client, googleIdentity, restore]);

  const cancelSignIn = useCallback(async () => {
    const flow = authFlow;
    loginAttemptRef.current += 1;
    setBusy(false);
    setAuthFlow(null);
    try {
      if (flow === "google") {
        authAbortRef.current?.abort();
        await googleIdentity?.cancel();
      } else if (flow === "browser") {
        await closeExternal?.();
      }
    } catch (cancelError) {
      // error-policy:J4 a failed native or browser cancellation is visible
      // instead of pretending the account chooser was dismissed.
      setError(errorMessage(cancelError));
    }
  }, [authFlow, closeExternal, googleIdentity]);

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
      try {
        await googleIdentity?.clearCredentialState();
      } catch (clearError) {
        // error-policy:J4 the Cloud session is already closed, so preserve the
        // truthful signed-out state while surfacing provider cleanup failure.
        setError(
          `You are signed out, but Google account state could not be cleared: ${errorMessage(clearError)}`,
        );
      }
    } catch (signOutError) {
      // error-policy:J4 failed logout remains visible without fabricating a
      // signed-out state that the client did not complete.
      setError(errorMessage(signOutError));
    } finally {
      setBusy(false);
    }
  }, [client, googleIdentity]);

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
      await voice?.stop();
      setListening(false);
      return;
    }
    if (!voice) {
      setError("Voice dictation is not available on this device.");
      return;
    }
    try {
      await voice.requestAndStart((value) => {
        const transcript = value.trim();
        if (transcript) {
          setDraft((current) => `${current}${current ? " " : ""}${transcript}`);
        }
        setListening(false);
      });
      setError(null);
      setListening(true);
    } catch (dictationError) {
      // error-policy:J4 denied or failed dictation is visible at the input.
      setListening(false);
      setError(errorMessage(dictationError));
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
          {busy && authFlow ? (
            <div className="space-y-3">
              <p
                aria-atomic="true"
                aria-live="polite"
                className="text-sm text-muted"
                role="status"
              >
                {authFlow === "google"
                  ? "Opening Google account chooser…"
                  : "Waiting for browser sign-in…"}
              </p>
              <Button
                type="button"
                variant="outline"
                size="touch"
                onClick={() => void cancelSignIn()}
                className="w-full"
              >
                Cancel sign-in
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {googleIdentity ? (
                <Button
                  aria-label="Sign in with Google"
                  unstyled
                  type="button"
                  onClick={() => void signInWithGoogle()}
                  className="mx-auto flex min-h-12 w-[180px] items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  <img
                    alt=""
                    aria-hidden="true"
                    className="h-10 w-[180px]"
                    data-testid="google-sign-in-neutral-asset"
                    height="40"
                    src={GOOGLE_SIGN_IN_NEUTRAL_ASSET}
                    width="180"
                  />
                </Button>
              ) : null}
              <Button
                type="button"
                variant={googleIdentity ? "outline" : "default"}
                size="touch"
                onClick={() => void signIn()}
                className="w-full"
              >
                {googleIdentity ? "Continue in browser" : "Sign in"}
              </Button>
            </div>
          )}
          {error && retrySessionAvailable ? (
            <Button
              type="button"
              variant="mutedLink"
              onClick={() => void restore()}
            >
              Retry session check
            </Button>
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
          <Button
            type="button"
            variant="ghostMuted"
            size="compact"
            onClick={() => {
              localStorage.removeItem(ANDROID_CLOUD_CONVERSATION_ID_KEY);
              setConversationId(null);
              setMessages([]);
            }}
          >
            New chat
          </Button>
          <Button
            type="button"
            variant="ghostMuted"
            size="compact"
            disabled={busy}
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
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
              <Button
                type="button"
                variant="mutedLink"
                onClick={() => speak(message.text)}
                className="mt-2"
              >
                Play
              </Button>
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
        <Button
          type="button"
          variant="outline"
          size="touch"
          aria-pressed={listening}
          aria-label={listening ? "Stop dictation" : "Start dictation"}
          onClick={() => void toggleDictation()}
        >
          {listening ? "Stop" : "Mic"}
        </Button>
        <label className="sr-only" htmlFor="android-cloud-message">
          Message Eliza
        </label>
        <Textarea
          variant="mobileComposer"
          density="singleLine"
          id="android-cloud-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={1}
          disabled={busy}
          className="flex-1"
          placeholder="Message Eliza"
        />
        {busy ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => abortRef.current?.abort()}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="submit"
            variant="default"
            size="touch"
            disabled={!draft.trim()}
          >
            Send
          </Button>
        )}
      </form>
    </main>
  );
}

export default AndroidCloudApp;
