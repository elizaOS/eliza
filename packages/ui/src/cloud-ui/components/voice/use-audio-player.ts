"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseAudioPlayerReturn {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  error: string | null;
  playAudio: (audioBlob: Blob | string) => Promise<void>;
  pauseAudio: () => void;
  resumeAudio: () => Promise<void>;
  stopAudio: () => void;
  seekTo: (time: number) => void;
}

export function useAudioPlayer(): UseAudioPlayerReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }

      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current);
      }
    };
  }, []);

  const playAudio = useCallback(async (audioSource: Blob | string) => {
    setError(null);

    try {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }

      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current);
        currentAudioUrlRef.current = null;
      }

      if (!audioRef.current) {
        audioRef.current = new Audio();

        audioRef.current.addEventListener("loadedmetadata", () => {
          setDuration(audioRef.current?.duration || 0);
        });

        audioRef.current.addEventListener("timeupdate", () => {
          setCurrentTime(audioRef.current?.currentTime || 0);
        });

        audioRef.current.addEventListener("ended", () => {
          setIsPlaying(false);
          setCurrentTime(0);
        });

        audioRef.current.addEventListener("error", () => {
          setError("Failed to play audio");
          setIsPlaying(false);
        });
      }

      let audioUrl: string;
      if (audioSource instanceof Blob) {
        audioUrl = URL.createObjectURL(audioSource);
        currentAudioUrlRef.current = audioUrl;
      } else {
        audioUrl = audioSource;
      }

      audioRef.current.src = audioUrl;
      await audioRef.current.play();
      setIsPlaying(true);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError(
          "Audio playback not allowed. Please interact with the page first.",
        );
      } else {
        setError("Failed to play audio. Please try again.");
      }

      setIsPlaying(false);
    }
  }, []);

  const pauseAudio = useCallback(() => {
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  }, []);

  const resumeAudio = useCallback(async () => {
    if (audioRef.current?.paused) {
      try {
        await audioRef.current.play();
        setIsPlaying(true);
      } catch (err) {
        if (err instanceof Error && err.name === "NotAllowedError") {
          setError(
            "Audio playback not allowed. Please interact with the page first.",
          );
        } else {
          setError("Failed to resume audio. Please try again.");
        }
        setIsPlaying(false);
      }
    }
  }, []);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, []);

  const seekTo = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  return {
    isPlaying,
    currentTime,
    duration,
    error,
    playAudio,
    pauseAudio,
    resumeAudio,
    stopAudio,
    seekTo,
  };
}
