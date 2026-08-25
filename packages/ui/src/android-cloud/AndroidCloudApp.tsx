/** Minimal Google Play consumer shell: Cloud auth, text/voice chat and history. */

import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShaderBackground } from "../backgrounds/ShaderBackground";
import { ChatBubble } from "../components/composites/chat/chat-bubble";
import { GlassIconButton } from "../components/shell/glass-composer";
import { GLASS_COMPOSER_CLASS } from "../components/shell/glass-composer.helpers";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import {
  FIRST_RUN_GREETING,
  FIRST_RUN_SIGN_IN_PROMPT,
} from "../first-run/first-run-greeting";
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
  openExternal?: (
    url: string,
  ) => Promise<"closed" | "opened"> | "closed" | "opened";
  closeExternal?: () => Promise<void> | void;
  voice?: AndroidCloudVoiceAdapter;
}

export interface AndroidCloudVoiceAdapter {
  requestAndStart(onFinalTranscript: (text: string) => void): Promise<void>;
  stop(): Promise<void>;
  speak(text: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

function defaultExternalOpen(url: string): "opened" {
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
  return "opened";
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
  const loginAttemptRef = useRef(0);

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
      setPhase(restored ? "ready" : "signed-out");
    } catch (restoreError) {
      // error-policy:J4 session verification failure becomes an explicit
      // signed-out error state with a retry affordance.
      setSession(null);
      setPhase("signed-out");
      setError(errorMessage(restoreError));
    }
  }, [client]);

  useEffect(() => {
    void restore();
    return () => {
      loginAttemptRef.current += 1;
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
    setBusy(true);
    setError(null);
    try {
      const attempt = await client.beginLogin();
      const externalState = await openExternal(attempt.browserUrl);
      if (externalState === "closed") {
        const result = await client.pollLogin(attempt.sessionId);
        if (result.status === "authenticated") {
          await restore();
          return;
        }
        if (result.status === "expired") throw new Error(result.error);
        return;
      }
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
      if (loginAttemptRef.current === attemptNumber) setBusy(false);
    }
  }, [client, closeExternal, openExternal, restore]);

  const cancelSignIn = useCallback(async () => {
    loginAttemptRef.current += 1;
    setBusy(false);
    try {
      await closeExternal?.();
    } catch (cancelError) {
      // error-policy:J4 a failed browser cancellation remains visible instead
      // of pretending the canonical Cloud sign-in surface was dismissed.
      setError(errorMessage(cancelError));
    }
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
      <main className="relative flex min-h-dvh overflow-hidden bg-bg text-txt">
        <ShaderBackground color="#08090a" glow="#303236" />
        <section
          aria-label="Eliza Cloud sign-in"
          className="relative z-[1] flex w-full flex-col justify-between px-4 pb-[max(4.5rem,env(safe-area-inset-bottom))] pt-[max(7rem,env(safe-area-inset-top))]"
        >
          <div className="mx-auto flex w-full max-w-lg flex-col items-start gap-3">
            <ChatBubble
              tone="assistant"
              variant="glass"
              data-testid="android-cloud-first-run-greeting"
              className="rounded-2xl rounded-bl-md border border-white/15 bg-black/20 px-3.5 py-2.5 text-base backdrop-blur-md"
            >
              {FIRST_RUN_GREETING}
            </ChatBubble>
            <ChatBubble
              tone="assistant"
              variant="glass"
              data-testid="android-cloud-first-run-sign-in"
              className="w-fit max-w-[88%] rounded-2xl rounded-bl-md border border-white/15 bg-black/20 px-3.5 py-3 text-base backdrop-blur-md"
            >
              <p className="mb-3">{FIRST_RUN_SIGN_IN_PROMPT}</p>
              {error ? (
                <p role="alert" className="mb-3 text-sm text-red-200/90">
                  {error}
                </p>
              ) : null}
              {busy ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-white/65">
                    Finish signing in with Steward, then return to Eliza.
                  </p>
                  <Button
                    type="button"
                    variant="surface"
                    size="compact"
                    onClick={() => void cancelSignIn()}
                  >
                    Cancel sign-in
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="surface"
                  size="touch"
                  onClick={() => void signIn()}
                  className="w-full max-w-[13.5rem]"
                >
                  Sign in to Eliza Cloud
                </Button>
              )}
              {error ? (
                <Button
                  type="button"
                  variant="mutedLink"
                  onClick={() => void restore()}
                  className="mt-2"
                >
                  Check for an existing session
                </Button>
              ) : null}
            </ChatBubble>
          </div>
          <div className="mx-auto w-full max-w-lg">
            <div
              className={GLASS_COMPOSER_CLASS}
              data-testid="android-cloud-locked-composer"
            >
              <Button
                type="button"
                variant="transparent"
                size="icon-lg"
                aria-label="chat actions"
                disabled
                className="grid shrink-0 place-items-center bg-transparent text-white/40"
              >
                <Plus className="size-5" aria-hidden />
              </Button>
              <Input
                type="text"
                disabled
                aria-label="message"
                placeholder="Sign in to start chatting"
                variant="embeddedName"
                density="compact"
                className="min-w-0 flex-1 disabled:opacity-100 placeholder:text-white/55"
              />
              <GlassIconButton icon="mic" label="Start voice input" disabled />
            </div>
          </div>
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
