/**
 * Speech-to-Text Hook for App Builder
 *
 * Provides high-quality audio recording and transcription using ElevenLabs STT API.
 * Features:
 * - Browser audio recording with MediaRecorder
 * - ElevenLabs STT for accurate transcription
 * - Real-time audio visualization data
 * - Graceful error handling
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  supportsMediaRecorder,
  supportsGetUserMedia,
  getSupportedMimeType,
  ensureAudioFormat,
} from "@/lib/utils/audio";

export interface UseAppBuilderSTTReturn {
  // State
  isRecording: boolean;
  isProcessing: boolean;
  recordingTime: number;
  audioLevel: number; // 0-1 for visualization
  error: string | null;

  // Actions
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>; // Returns transcription
  cancelRecording: () => void;

  // Browser support
  isSupported: boolean;
}

export function useAppBuilderSTT(): UseAppBuilderSTTReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const resolveTranscriptionRef = useRef<
    ((value: string | null) => void) | null
  >(null);

  // Check browser support on mount
  useEffect(() => {
    const supported = supportsGetUserMedia() && supportsMediaRecorder();
    setIsSupported(supported);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  // Audio level visualization
  const updateAudioLevel = useCallback(() => {
    if (!analyzerRef.current) return;

    const dataArray = new Uint8Array(analyzerRef.current.frequencyBinCount);
    analyzerRef.current.getByteFrequencyData(dataArray);

    // Calculate average level
    const sum = dataArray.reduce((acc, val) => acc + val, 0);
    const average = sum / dataArray.length;
    const normalized = Math.min(average / 128, 1); // Normalize to 0-1

    setAudioLevel(normalized);

    if (isRecording) {
      animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
    }
  }, [isRecording]);

  const startRecording = useCallback(async () => {
    setError(null);
    audioChunksRef.current = [];

    if (!supportsGetUserMedia()) {
      setError("Your browser doesn't support audio recording");
      toast.error("Your browser doesn't support audio recording");
      return;
    }

    if (!supportsMediaRecorder()) {
      setError("Your browser doesn't support MediaRecorder");
      toast.error("Your browser doesn't support MediaRecorder");
      return;
    }

    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      streamRef.current = stream;

      // Setup audio analyzer for visualization
      try {
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        const analyzer = audioContext.createAnalyser();
        analyzer.fftSize = 256;
        source.connect(analyzer);
        analyzerRef.current = analyzer;
      } catch (err) {
        console.warn("[STT] Failed to setup audio analyzer:", err);
      }

      // Get supported MIME type
      const mimeType = getSupportedMimeType();
      if (!mimeType) {
        setError("No supported audio format found");
        toast.error("No supported audio format found");
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000,
      });
      mediaRecorderRef.current = mediaRecorder;

      // Collect audio chunks
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      });

      // Start recording
      mediaRecorder.start(100);
      setIsRecording(true);
      setRecordingTime(0);

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);

      // Start audio level updates
      animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
    } catch (err) {
      console.error("[STT] Error starting recording:", err);

      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError"
        ) {
          setError("Microphone permission denied");
          toast.error("Microphone permission denied. Please allow access.");
        } else if (err.name === "NotFoundError") {
          setError("No microphone found");
          toast.error("No microphone found. Please connect a microphone.");
        } else {
          setError("Failed to start recording");
          toast.error("Failed to start recording. Please try again.");
        }
      } else {
        setError("Failed to start recording");
        toast.error("Failed to start recording. Please try again.");
      }
    }
  }, [updateAudioLevel]);

  const processAudioAndTranscribe = useCallback(
    async (audioBlob: Blob): Promise<string | null> => {
      setIsProcessing(true);

      try {
        // Ensure proper audio format
        const processedBlob = await ensureAudioFormat(audioBlob);

        // Create FormData
        const formData = new FormData();
        const audioFile = new File([processedBlob], "recording.webm", {
          type: processedBlob.type || "audio/webm",
        });
        formData.append("audio", audioFile);

        // Call STT API
        const response = await fetch("/api/elevenlabs/stt", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMsg = errorData.error || "Failed to transcribe audio";
          toast.error(errorMsg);
          console.error("[STT] API error:", errorData);
          return null;
        }

        const { transcript } = await response.json();

        if (!transcript || transcript.trim().length === 0) {
          toast.error("No speech detected. Please try again.");
          return null;
        }

        return transcript.trim();
      } catch (err) {
        console.error("[STT] Processing error:", err);
        toast.error("Failed to process audio. Please try again.");
        return null;
      } finally {
        setIsProcessing(false);
      }
    },
    [],
  );

  const stopRecording = useCallback(async (): Promise<string | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current || !isRecording) {
        resolve(null);
        return;
      }

      // Clear timer
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      // Stop visualization
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      setAudioLevel(0);

      // Store resolve function for use in onstop handler
      const mediaRecorder = mediaRecorderRef.current;
      const mimeType = mediaRecorder.mimeType;

      mediaRecorder.onstop = async () => {
        setIsRecording(false);

        // Stop stream tracks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        // Close audio context
        if (audioContextRef.current) {
          await audioContextRef.current.close();
          audioContextRef.current = null;
          analyzerRef.current = null;
        }

        // Create audio blob and transcribe
        if (audioChunksRef.current.length > 0) {
          const audioBlob = new Blob(audioChunksRef.current, {
            type: mimeType,
          });
          audioChunksRef.current = [];

          const transcript = await processAudioAndTranscribe(audioBlob);
          resolve(transcript);
        } else {
          resolve(null);
        }
      };

      mediaRecorder.stop();
    });
  }, [isRecording, processAudioAndTranscribe]);

  const cancelRecording = useCallback(() => {
    // Clear timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    // Stop visualization
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setAudioLevel(0);

    // Stop media recorder without processing
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }

    // Stop stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
      analyzerRef.current = null;
    }

    audioChunksRef.current = [];
    setIsRecording(false);
    setRecordingTime(0);
  }, [isRecording]);

  return {
    isRecording,
    isProcessing,
    recordingTime,
    audioLevel,
    error,
    startRecording,
    stopRecording,
    cancelRecording,
    isSupported,
  };
}
