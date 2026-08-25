/** Minimal Google Play consumer shell: Cloud auth, text/voice chat and history. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  type AndroidCloudAccountLifecycleAdapter,
  AndroidCloudSettings,
} from "./AndroidCloudSettings";
import type { AccountDeletionRequestDto } from "./account-deletion-contract";
import {
  AndroidCloudClient,
  type AndroidCloudSession,
} from "./android-cloud-client";

export type { AndroidCloudAccountLifecycleAdapter } from "./AndroidCloudSettings";

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
  accountLifecycle?: AndroidCloudAccountLifecycleAdapter;
  openAppSettings?: () => Promise<void> | void;
}

export interface AndroidCloudVoiceAdapter {
  requestAndStart(
    onFinalTranscript: (text: string) => void,
    onError: (error: Error) => void,
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
  accountLifecycle,
  openAppSettings,
}: AndroidCloudAppProps): React.JSX.Element {
  const client = useMemo(
    () => clientOverride ?? new AndroidCloudClient(),
    [clientOverride],
  );
  const [session, setSession] = useState<AndroidCloudSession | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [phase, setPhase] = useState<
    "loading" | "signed-out" | "ready" | "deletion-status"
  >("loading");
  const [screen, setScreen] = useState<"chat" | "settings">("chat");
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [deletionRequest, setDeletionRequest] =
    useState<AccountDeletionRequestDto | null>(null);
  const [messages, setMessages] = useState<AndroidCloudMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loginAbortRef = useRef<AbortController | null>(null);
  const loginAttemptRef = useRef(0);
  const touchStartXRef = useRef<number | null>(null);

  const restore = useCallback(async () => {
    setError(null);
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
      if (restored) {
        setDeletionRequest(null);
        setPhase("ready");
      } else if (accountLifecycle) {
        const status = await accountLifecycle.getStatus();
        if (status) {
          setDeletionRequest(status);
          setPhase("deletion-status");
        } else {
          setPhase("signed-out");
        }
      } else {
        setPhase("signed-out");
      }
    } catch (restoreError) {
      // error-policy:J4 session verification failure becomes an explicit
      // signed-out error state with a retry affordance.
      setSession(null);
      setPhase("signed-out");
      setError(errorMessage(restoreError));
    }
  }, [accountLifecycle, client]);

  useEffect(() => {
    void restore();
    return () => {
      loginAttemptRef.current += 1;
      loginAbortRef.current?.abort();
      abortRef.current?.abort();
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
    const controller = new AbortController();
    loginAbortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const attempt = await client.beginLogin(controller.signal);
      if (loginAttemptRef.current !== attemptNumber) return;
      await openExternal(attempt.browserUrl);
      if (loginAttemptRef.current !== attemptNumber) {
        await closeExternal?.();
        return;
      }
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, LOGIN_POLL_MS),
        );
        if (loginAttemptRef.current !== attemptNumber) return;
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
        if (
          controller.signal.aborted ||
          loginAttemptRef.current !== attemptNumber
        ) {
          await client.discardLogin(result.token);
          return;
        }
        await closeExternal?.();
        await restore();
        return;
      }
      throw new Error("Sign-in timed out. Please try again.");
    } catch (signInError) {
      // error-policy:J4 the sign-in boundary renders the actionable failure.
      if (!controller.signal.aborted) setError(errorMessage(signInError));
    } finally {
      if (loginAbortRef.current === controller) loginAbortRef.current = null;
      if (loginAttemptRef.current === attemptNumber) setBusy(false);
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
      setScreen("chat");
      setLauncherOpen(false);
      setPhase("signed-out");
    } catch (signOutError) {
      // error-policy:J4 failed logout remains visible without fabricating a
      // signed-out state that the client did not complete.
      setError(errorMessage(signOutError));
    } finally {
      setBusy(false);
    }
  }, [client]);

  const onDeletionReserved = useCallback(
    async (request: AccountDeletionRequestDto) => {
      await client.signOut();
      localStorage.removeItem(ANDROID_CLOUD_CONVERSATION_ID_KEY);
      setSession(null);
      setConversationId(null);
      setMessages([]);
      setDeletionRequest(request);
      setLauncherOpen(false);
      setPhase("deletion-status");
    },
    [client],
  );

  const newChat = useCallback(() => {
    localStorage.removeItem(ANDROID_CLOUD_CONVERSATION_ID_KEY);
    setConversationId(null);
    setMessages([]);
    setScreen("chat");
    setLauncherOpen(false);
  }, []);

  const finishSwipe = useCallback((clientX: number) => {
    const start = touchStartXRef.current;
    touchStartXRef.current = null;
    if (start === null) return;
    const delta = clientX - start;
    if (delta < -56) setLauncherOpen(true);
    if (delta > 56) setLauncherOpen(false);
  }, []);

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
      let nativeAttemptFinished = false;
      await voice.requestAndStart(
        (value) => {
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
          nativeAttemptFinished = true;
          setListening(false);
          setError(errorMessage(nativeError));
        },
      );
      if (!nativeAttemptFinished) {
        setError(null);
        setListening(true);
      }
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
          {busy ? (
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={cancelSignIn}
              className="w-full"
            >
              Cancel sign-in
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              size="touch"
              onClick={() => void signIn()}
              className="w-full"
            >
              Sign in
            </Button>
          )}
          {error ? (
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

  if (phase === "deletion-status") {
    return (
      <AndroidCloudSettings
        lifecycle={accountLifecycle}
        initialRequest={deletionRequest}
        backLabel="Back to sign in"
        onBack={() => setPhase("signed-out")}
        onSignOut={() => setPhase("signed-out")}
        onDeletionReserved={onDeletionReserved}
        openExternal={openExternal}
        openAppSettings={openAppSettings}
      />
    );
  }

  if (screen === "settings") {
    return (
      <AndroidCloudSettings
        displayName={session?.identity.displayName}
        lifecycle={accountLifecycle}
        onBack={() => setScreen("chat")}
        onSignOut={signOut}
        onDeletionReserved={onDeletionReserved}
        openExternal={openExternal}
        openAppSettings={openAppSettings}
      />
    );
  }

  return (
    <main
      className="relative flex min-h-dvh flex-col overflow-hidden bg-bg text-txt"
      onTouchStart={(event) => {
        touchStartXRef.current = event.changedTouches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const end = event.changedTouches[0]?.clientX;
        if (typeof end === "number") finishSwipe(end);
      }}
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <Button
          type="button"
          variant="outline"
          size="touch"
          aria-label="Open launcher"
          onClick={() => setLauncherOpen(true)}
        >
          Menu
        </Button>
        <div className="text-center">
          <h1 className="font-semibold">Eliza</h1>
          <p className="text-xs text-muted">{session?.identity.displayName}</p>
        </div>
        <span className="w-[4.5rem]" aria-hidden="true" />
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
      {launcherOpen ? (
        <div className="absolute inset-0 z-40 flex bg-black/70">
          <Button
            type="button"
            unstyled
            className="flex-1"
            aria-label="Close launcher"
            onClick={() => setLauncherOpen(false)}
          />
          <nav
            className="flex w-[min(82vw,22rem)] flex-col gap-2 border-l border-border bg-card p-5 pt-[max(1.25rem,env(safe-area-inset-top))]"
            aria-label="Eliza launcher"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Eliza</h2>
              <Button
                type="button"
                variant="outline"
                size="touch"
                onClick={() => setLauncherOpen(false)}
              >
                Close
              </Button>
            </div>
            <Button
              type="button"
              variant="default"
              size="touch"
              align="start"
              className="w-full"
              onClick={newChat}
            >
              New chat
            </Button>
            <Button
              type="button"
              variant="outline"
              size="touch"
              align="start"
              className="w-full"
              onClick={() => {
                setScreen("settings");
                setLauncherOpen(false);
              }}
            >
              Settings
            </Button>
            <p className="mt-auto text-xs leading-relaxed text-muted">
              Play-safe Android includes chat, voice, account controls, and
              standard platform permissions. Additional views appear only when
              they meet the same Play policy boundary.
            </p>
          </nav>
        </div>
      ) : null}
    </main>
  );
}

export default AndroidCloudApp;
