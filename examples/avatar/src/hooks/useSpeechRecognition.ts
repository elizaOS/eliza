import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SpeechRecognitionLike = EventTarget & {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
};

type SpeechRecognitionResultListLike = {
  length: number;
  item(index: number): SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternativeLike;
  [index: number]: SpeechRecognitionAlternativeLike;
};

type SpeechRecognitionAlternativeLike = {
  transcript: string;
  confidence: number;
};

type SpeechRecognitionErrorEventLike = Event & {
  error: string;
  message: string;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const g = globalThis as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

export function useSpeechRecognition(lang = "en-US") {
  const ctor = useMemo(() => getSpeechRecognitionConstructor(), []);
  const supported = ctor !== null;

  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);

  const clear = useCallback(() => {
    setInterimTranscript("");
    setFinalTranscript("");
    setError(null);
  }, []);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      // ignore
    }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (!ctor) return;
    clear();

    const rec = new ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    recRef.current = rec;

    rec.onresult = (ev: SpeechRecognitionEventLike) => {
      let interim = "";
      let final = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results.item(i);
        const alt = result.item(0);
        if (result.isFinal) final += alt.transcript;
        else interim += alt.transcript;
      }
      if (interim) setInterimTranscript(interim.trim());
      if (final) setFinalTranscript((prev) => `${prev} ${final}`.trim());
    };

    rec.onerror = (ev: SpeechRecognitionErrorEventLike) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      setError(ev.error || ev.message || "speech-recognition-error");
    };

    rec.onend = () => {
      setListening(false);
    };

    try {
      rec.start();
      setListening(true);
    } catch {
      // ignore
    }
  }, [ctor, lang, clear]);

  useEffect(() => {
    return () => {
      const rec = recRef.current;
      if (!rec) return;
      try {
        rec.abort();
      } catch {
        // ignore
      }
      recRef.current = null;
    };
  }, []);

  return {
    supported,
    listening,
    interimTranscript,
    finalTranscript,
    error,
    start,
    stop,
    clear,
  };
}

