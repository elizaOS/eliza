import { useCallback, useEffect, useRef, useState } from "react";

type VADOptions = {
  /** Silence duration (ms) before sending (default: 1200) */
  silenceThreshold?: number;
  /** Sample rate for analysis (default: 100ms) */
  sampleRate?: number;
  /** Language for speech recognition */
  lang?: string;
  /** Whether to enable echo cancellation */
  echoCancellation?: boolean;
  /** Ignore recognition results briefly after agent speech ends (default: 500ms) */
  echoCooldownMs?: number;
  /** Duration (ms) of sustained audio to trigger barge-in (default: 300) */
  bargeInDuration?: number;
  /** Energy threshold for barge-in detection (default: 0.05) */
  bargeInThreshold?: number;
};

type VADState = {
  supported: boolean;
  listening: boolean;
  speaking: boolean;
  transcript: string;
  interimTranscript: string;
  error: string | null;
  audioLevel: number;
};

type VADControls = {
  start: () => void;
  stop: () => void;
  clear: () => void;
  restart: () => void;
  setAgentSpeaking: (speaking: boolean) => void;
};

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
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
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

export function useVoiceActivityDetection(
  options: VADOptions = {},
  onFinalTranscript?: (transcript: string) => void,
  onBargeIn?: () => void,
): VADState & VADControls {
  const {
    silenceThreshold = 1200,
    sampleRate = 100,
    lang = "en-US",
    echoCancellation = true,
    echoCooldownMs = 500,
    bargeInDuration = 300,
    bargeInThreshold = 0.05,
  } = options;

  const ctor = getSpeechRecognitionConstructor();
  const supported = ctor !== null;

  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const agentSpeakingRef = useRef(false);
  const echoCooldownUntilMsRef = useRef<number>(0);
  const accumulatedTranscriptRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isActiveRef = useRef(false);
  const bargeInStartRef = useRef<number | null>(null);
  const bargeInTriggeredRef = useRef(false);
  const onBargeInRef = useRef(onBargeIn);
  const lastAudioSampleMsRef = useRef<number>(0);

  // Keep callback ref updated
  useEffect(() => {
    onBargeInRef.current = onBargeIn;
  }, [onBargeIn]);

  const canAcceptRecognitionInput = useCallback((): boolean => {
    if (!isActiveRef.current) return false;
    if (agentSpeakingRef.current) return false;
    if (Date.now() < echoCooldownUntilMsRef.current) return false;
    return true;
  }, []);

  const analyzeAudio = useCallback(() => {
    if (!analyserRef.current || !isActiveRef.current) return;

    const now = Date.now();
    if (now - lastAudioSampleMsRef.current < sampleRate) {
      animationFrameRef.current = requestAnimationFrame(analyzeAudio);
      return;
    }
    lastAudioSampleMsRef.current = now;

    const analyser = analyserRef.current;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / dataArray.length) / 255;
    setAudioLevel(rms);

    if (agentSpeakingRef.current) {
      // Barge-in detection: user speaking over agent
      if (rms > bargeInThreshold && !bargeInTriggeredRef.current) {
        if (bargeInStartRef.current === null) {
          bargeInStartRef.current = now;
        } else if (now - bargeInStartRef.current > bargeInDuration) {
          // Sustained audio detected - trigger barge-in
          bargeInTriggeredRef.current = true;
          onBargeInRef.current?.();
        }
      } else if (rms <= bargeInThreshold) {
        // Reset if audio drops
        bargeInStartRef.current = null;
      }
    } else {
      // Reset barge-in state when agent not speaking
      bargeInStartRef.current = null;
      bargeInTriggeredRef.current = false;
    }

    animationFrameRef.current = requestAnimationFrame(analyzeAudio);
  }, [bargeInDuration, bargeInThreshold, sampleRate]);

  const setupAudioAnalysis = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      animationFrameRef.current = requestAnimationFrame(analyzeAudio);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to access microphone");
    }
  }, [echoCancellation, analyzeAudio]);

  const cleanupAudio = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  const handleTranscript = useCallback(
    (text: string, isFinal: boolean) => {
      // Echo cancellation / cooldown gating
      if (!canAcceptRecognitionInput()) return;

      if (isFinal && text.trim()) {
        accumulatedTranscriptRef.current += ` ${text.trim()}`;
        setTranscript(accumulatedTranscriptRef.current.trim());

        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
        }

        silenceTimerRef.current = setTimeout(() => {
          const finalText = accumulatedTranscriptRef.current.trim();
          if (finalText && onFinalTranscript) {
            onFinalTranscript(finalText);
            accumulatedTranscriptRef.current = "";
            setTranscript("");
            setInterimTranscript("");
            setSpeaking(false);

            // Reset recognition after sending to keep voice mode continuous.
            // Instead of directly starting a new recognizer (which can race on some browsers),
            // abort the current session and let `onend` restart cleanly.
            if (isActiveRef.current && !agentSpeakingRef.current && recRef.current) {
              try {
                recRef.current.abort();
              } catch {
                // ignore
              }
              recRef.current = null;
            }
          }
        }, silenceThreshold);
      } else {
        setInterimTranscript(text);
        if (text.trim()) {
          setSpeaking(true);
        }
      }
    },
    [canAcceptRecognitionInput, silenceThreshold, onFinalTranscript],
  );

  const startRecognition = useCallback(() => {
    if (!ctor) return;

    // Don't start recognition while agent is speaking or during echo cooldown.
    if (!canAcceptRecognitionInput()) return;

    // Don't create a new instance if one already exists
    if (recRef.current) {
      try {
        recRef.current.abort();
      } catch {
        // ignore
      }
      recRef.current = null;
    }

    const rec = new ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    recRef.current = rec;

    rec.onresult = (ev: SpeechRecognitionEventLike) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results.item(i);
        const alt = result.item(0);
        handleTranscript(alt.transcript, result.isFinal);
      }
    };

    rec.onspeechstart = () => setSpeaking(true);
    rec.onspeechend = () => setSpeaking(false);

    rec.onerror = (ev: SpeechRecognitionErrorEventLike) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      setError(ev.error || ev.message || "speech-recognition-error");
    };

    rec.onend = () => {
      recRef.current = null; // Clear ref when ended
      if (!isActiveRef.current) return;
      if (agentSpeakingRef.current) return;

      const now = Date.now();
      const cooldownUntil = echoCooldownUntilMsRef.current;
      const delay = now < cooldownUntil ? Math.max(0, cooldownUntil - now) : 100;

      restartTimeoutRef.current = setTimeout(() => {
        if (isActiveRef.current && !recRef.current && canAcceptRecognitionInput()) {
          startRecognition();
        }
      }, delay);
    };

    try {
      rec.start();
    } catch {
      recRef.current = null;
    }
  }, [ctor, lang, handleTranscript, canAcceptRecognitionInput]);

  const start = useCallback(() => {
    if (!supported) return;
    isActiveRef.current = true;
    setError(null);
    setTranscript("");
    setInterimTranscript("");
    accumulatedTranscriptRef.current = "";
    setListening(true);
    void setupAudioAnalysis();
    startRecognition();
  }, [supported, setupAudioAnalysis, startRecognition]);

  const stop = useCallback(() => {
    isActiveRef.current = false;
    setListening(false);
    setSpeaking(false);
    echoCooldownUntilMsRef.current = 0;
    lastAudioSampleMsRef.current = 0;

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    if (recRef.current) {
      try {
        recRef.current.abort();
      } catch {
        // ignore
      }
      recRef.current = null;
    }
    cleanupAudio();
  }, [cleanupAudio]);

  const clear = useCallback(() => {
    setTranscript("");
    setInterimTranscript("");
    accumulatedTranscriptRef.current = "";
    setError(null);
  }, []);

  // Restart recognition (useful after agent finishes speaking)
  const restart = useCallback(() => {
    if (!supported) return;
    if (!isActiveRef.current) return;
    if (agentSpeakingRef.current) return;

    // Clear any pending timers
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    // Clear state
    setTranscript("");
    setInterimTranscript("");
    accumulatedTranscriptRef.current = "";
    setSpeaking(false);

    // Start fresh recognition (it will abort existing if any)
    startRecognition();
  }, [supported, startRecognition]);

  const setAgentSpeaking = useCallback((speakingNow: boolean) => {
    const prev = agentSpeakingRef.current;
    agentSpeakingRef.current = speakingNow;

    if (speakingNow) {
      // Pause recognition while agent is speaking so we don't capture TTS.
      echoCooldownUntilMsRef.current = Date.now() + echoCooldownMs;
      bargeInStartRef.current = null;
      bargeInTriggeredRef.current = false;

      if (recRef.current) {
        try {
          recRef.current.abort();
        } catch {
          // ignore
        }
        recRef.current = null;
      }

      setInterimTranscript("");
      setSpeaking(false);
      return;
    }

    // Agent just finished speaking: apply a cooldown, then restart recognition.
    if (prev && isActiveRef.current) {
      echoCooldownUntilMsRef.current = Date.now() + echoCooldownMs;
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = setTimeout(() => {
        if (isActiveRef.current && !agentSpeakingRef.current && !recRef.current) {
          startRecognition();
        }
      }, echoCooldownMs);
    }
  }, [echoCooldownMs, startRecognition]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    supported,
    listening,
    speaking,
    transcript,
    interimTranscript,
    error,
    audioLevel,
    start,
    stop,
    clear,
    restart,
    setAgentSpeaking,
  };
}

