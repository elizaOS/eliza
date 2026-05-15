/**
 * Audio recorder hook providing browser audio recording functionality.
 * Supports start, stop, pause, resume, and recording time tracking.
 *
 * @returns {UseAudioRecorderReturn} Audio recorder state and control functions
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getSupportedMimeType,
  supportsGetUserMedia,
  supportsMediaRecorder,
} from "@/lib/utils/audio";

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
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearTimer();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      stopStream();
    };
  }, [clearTimer, stopStream]);

  const startRecording = useCallback(async () => {
    setError(null);
    setAudioBlob(null);
    audioChunksRef.current = [];

    // Check browser support
    if (!supportsGetUserMedia()) {
      setError("Your browser doesn't support audio recording");
      return;
    }

    if (!supportsMediaRecorder()) {
      setError("Your browser doesn't support MediaRecorder");
      return;
    }

    try {
      // Request microphone access - explicitly only audio, no video
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false, // Explicitly disable video to prevent video/webm containers
      });

      streamRef.current = stream;

      // Get supported MIME type
      const mimeType = getSupportedMimeType();
      if (!mimeType) {
        setError("No supported audio format found");
        stopStream();
        return;
      }

      // Create MediaRecorder with audio-only constraints
      const options: MediaRecorderOptions = {
        mimeType,
        audioBitsPerSecond: 128000, // 128kbps
      };

      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;

      // Collect audio chunks
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      });

      // Handle recording stop
      mediaRecorder.addEventListener("stop", () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        if (mountedRef.current) {
          setAudioBlob(audioBlob);
          setIsRecording(false);
          setIsPaused(false);
        }

        stopStream();
        clearTimer();
      });

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      setIsRecording(true);
      setRecordingTime(0);

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Error starting recording:", err);

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
    }
  }, [clearTimer, stopStream]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  }, [isRecording]);

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording && !isPaused) {
      mediaRecorderRef.current.pause();
      setIsPaused(true);
      clearTimer();
    }
  }, [clearTimer, isRecording, isPaused]);

  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording && isPaused) {
      mediaRecorderRef.current.resume();
      setIsPaused(false);

      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    }
  }, [isRecording, isPaused]);

  const clearRecording = useCallback(() => {
    setAudioBlob(null);
    setRecordingTime(0);
    setError(null);
    audioChunksRef.current = [];
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
