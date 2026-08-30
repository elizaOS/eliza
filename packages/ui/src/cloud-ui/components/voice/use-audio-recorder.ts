"use client";

/**
 * Hook wrapping MediaRecorder capture for the voice-clone surface (start/stop, level, blob).
 *
 * Two lifecycle invariants matter here. Chunks are collected in an array local
 * to each recorder generation, so a stale recorder's asynchronously queued
 * `dataavailable` can never contaminate a later session's blob. And because
 * MediaRecorder.stop() flips state to "inactive" synchronously while queueing
 * its `dataavailable`/`stop` events asynchronously, an explicit stopping phase
 * keeps `mediaRecorderRef` alive until the terminal `stop` event assembles the
 * blob — a second stop click in that window is a no-op instead of a discard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportRendererDiagnostic } from "../../../utils/renderer-diagnostics";
import {
  getMediaRecorderConstructor,
  getSupportedMimeType,
  isUsableMediaRecorder,
  supportsGetUserMedia,
} from "./audio-utils";

export interface UseAudioRecorderReturn {
  isRecording: boolean;
  isPaused: boolean;
  recordingTime: number;
  audioBlob: Blob | null;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  pauseRecording: () => void;
  resumeRecording: () => void;
  clearRecording: () => void;
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const startAttemptRef = useRef(0);
  const startPendingRef = useRef(false);
  const stoppingRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopTracks = useCallback((stream: MediaStream | null) => {
    if (!stream) {
      return;
    }

    try {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch (error) {
          // error-policy:J6 Media-track teardown is best effort during cleanup.
          reportRendererDiagnostic({
            scope: "voice.recording.track.stop",
            error,
          });
        }
      }
    } catch (error) {
      // error-policy:J6 A malformed stream must not prevent the remaining teardown.
      reportRendererDiagnostic({
        scope: "voice.recording.stream.cleanup",
        error,
      });
    }
  }, []);

  const stopStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stopTracks(stream);
  }, [stopTracks]);

  const resetRecorderState = useCallback(() => {
    mediaRecorderRef.current = null;
    stoppingRef.current = false;
    clearTimer();
    stopStream();
    if (mountedRef.current) {
      setIsRecording(false);
      setIsPaused(false);
    }
  }, [clearTimer, stopStream]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startAttemptRef.current += 1;
      startPendingRef.current = false;
      clearTimer();
      const recorder = mediaRecorderRef.current;
      mediaRecorderRef.current = null;
      stoppingRef.current = false;
      if (recorder) {
        try {
          if (recorder.state !== "inactive") {
            recorder.stop();
          }
        } catch (error) {
          // error-policy:J6 Recorder teardown is best effort during unmount.
          reportRendererDiagnostic({
            scope: "voice.recording.unmount.stop",
            error,
          });
        }
      }
      stopStream();
    };
  }, [clearTimer, stopStream]);

  const startRecording = useCallback(async () => {
    if (startPendingRef.current || mediaRecorderRef.current) {
      return;
    }

    startPendingRef.current = true;
    const attempt = ++startAttemptRef.current;
    setError(null);
    setAudioBlob(null);

    let acquiredStream: MediaStream | null = null;
    let createdRecorder: MediaRecorder | null = null;

    try {
      if (!supportsGetUserMedia()) {
        setError("Your browser doesn't support audio recording");
        return;
      }

      const MediaRecorderConstructor = getMediaRecorderConstructor();
      if (!MediaRecorderConstructor) {
        setError("Your browser doesn't support MediaRecorder");
        return;
      }

      acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      if (!mountedRef.current || attempt !== startAttemptRef.current) {
        stopTracks(acquiredStream);
        return;
      }

      const mimeType = getSupportedMimeType(MediaRecorderConstructor);
      if (!mimeType) {
        setError("No supported audio format found");
        stopTracks(acquiredStream);
        return;
      }

      const recorderCandidate = new MediaRecorderConstructor(acquiredStream, {
        mimeType,
        audioBitsPerSecond: 128000,
      });
      if (!isUsableMediaRecorder(recorderCandidate)) {
        throw new TypeError("MediaRecorder returned an unusable instance");
      }
      createdRecorder = recorderCandidate;
      streamRef.current = acquiredStream;
      mediaRecorderRef.current = createdRecorder;

      // Chunks are scoped to this recorder generation so a stale recorder's
      // async-queued dataavailable cannot contaminate a later session's blob.
      const chunks: Blob[] = [];
      createdRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      });

      createdRecorder.start(100);
      createdRecorder.addEventListener("stop", () => {
        if (mediaRecorderRef.current !== createdRecorder) {
          return;
        }
        const audioBlob = new Blob(chunks, { type: mimeType });
        if (mountedRef.current) {
          setAudioBlob(audioBlob);
        }
        resetRecorderState();
      });
      setIsRecording(true);
      setRecordingTime(0);

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      // error-policy:J4 Recording failures become an explicit user-facing error state.
      reportRendererDiagnostic({ scope: "voice.recording.start", error: err });

      if (createdRecorder) {
        try {
          if (createdRecorder.state !== "inactive") {
            createdRecorder.stop();
          }
        } catch (stopError) {
          // error-policy:J6 A failed partial recorder is cleaned up best effort.
          reportRendererDiagnostic({
            scope: "voice.recording.start.cleanup",
            error: stopError,
          });
        }
      }
      if (mediaRecorderRef.current === createdRecorder) {
        mediaRecorderRef.current = null;
      }
      if (streamRef.current === acquiredStream) {
        streamRef.current = null;
      }
      stopTracks(acquiredStream);
      clearTimer();
      if (mountedRef.current) {
        setIsRecording(false);
        setIsPaused(false);
      }

      if (!mountedRef.current) {
        return;
      }
      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError"
        ) {
          setError(
            "Microphone permission denied. Please allow microphone access.",
          );
        } else if (err.name === "NotFoundError") {
          setError("No microphone found. Please connect a microphone.");
        } else {
          setError("Failed to start recording. Please try again.");
        }
      } else {
        setError("Failed to start recording. Please try again.");
      }
    } finally {
      if (attempt === startAttemptRef.current) {
        startPendingRef.current = false;
      }
    }
  }, [clearTimer, resetRecorderState, stopTracks]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || !isRecording || stoppingRef.current) {
      return;
    }

    try {
      if (recorder.state === "inactive") {
        // Fallback for a recorder that never started; a stopping recorder is
        // also sync-inactive but is covered by the stoppingRef guard above so
        // its queued stop event can still assemble the blob.
        resetRecorderState();
        return;
      }
      stoppingRef.current = true;
      recorder.stop();
    } catch (stopError) {
      // error-policy:J4 Stop failures become visible and still release resources.
      reportRendererDiagnostic({
        scope: "voice.recording.stop",
        error: stopError,
      });
      setError("Failed to stop recording. Please try again.");
      resetRecorderState();
    }
  }, [isRecording, resetRecorderState]);

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording && !isPaused) {
      try {
        mediaRecorderRef.current.pause();
        setIsPaused(true);
        clearTimer();
      } catch (pauseError) {
        // error-policy:J4 Pause failures become an explicit user-facing error state.
        reportRendererDiagnostic({
          scope: "voice.recording.pause",
          error: pauseError,
        });
        setError("Failed to pause recording. Please try again.");
      }
    }
  }, [clearTimer, isRecording, isPaused]);

  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording && isPaused) {
      try {
        mediaRecorderRef.current.resume();
        setIsPaused(false);

        timerRef.current = setInterval(() => {
          setRecordingTime((prev) => prev + 1);
        }, 1000);
      } catch (resumeError) {
        // error-policy:J4 Resume failures become an explicit user-facing error state.
        reportRendererDiagnostic({
          scope: "voice.recording.resume",
          error: resumeError,
        });
        setError("Failed to resume recording. Please try again.");
      }
    }
  }, [isRecording, isPaused]);

  const clearRecording = useCallback(() => {
    setAudioBlob(null);
    setRecordingTime(0);
    setError(null);
  }, []);

  return useMemo(
    () => ({
      isRecording,
      isPaused,
      recordingTime,
      audioBlob,
      error,
      startRecording,
      stopRecording,
      pauseRecording,
      resumeRecording,
      clearRecording,
    }),
    [
      isRecording,
      isPaused,
      recordingTime,
      audioBlob,
      error,
      startRecording,
      stopRecording,
      pauseRecording,
      resumeRecording,
      clearRecording,
    ],
  );
}
