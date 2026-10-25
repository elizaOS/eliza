/** Generic event callback used across Capacitor/Electrobun plugin bridges. */
export type EventCallback<T = unknown> = (event: T) => void;

/** Generic listener entry used by Electrobun plugin bridges. */
export interface ListenerEntry<
  TEventName extends string = string,
  TEventData = unknown,
> {
  eventName: TEventName;
  callback: EventCallback<TEventData>;
}

// ---------------------------------------------------------------------------
// Web Speech API shims
//
// TypeScript's lib.dom.d.ts does not expose SpeechRecognition in all
// compiler targets. These minimal interfaces cover the surface used by the
// web implementations of the Swabble and TalkMode plugins.
// ---------------------------------------------------------------------------

/** Minimal interface for a Web Speech API SpeechRecognition instance. */
export interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((this: SpeechRecognitionInstance) => void) | null;
  onend: ((this: SpeechRecognitionInstance) => void) | null;
  /** `message` is present in some browsers but not standardised. */
  onerror:
    | ((
        this: SpeechRecognitionInstance,
        event: { error: string; message?: string },
      ) => void)
    | null;
  onresult:
    | ((
        this: SpeechRecognitionInstance,
        event: SpeechRecognitionResultEvent,
      ) => void)
    | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechRecognitionResultEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

export interface SpeechRecognitionResultList {
  length: number;
  [index: number]: {
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  };
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

export interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}
