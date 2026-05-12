/**
 * Voice audio player component with playback controls.
 * Supports play/pause, volume control, mute, and progress tracking.
 *
 * @param props - Voice audio player configuration
 * @param props.audioUrl - URL of audio file to play
 * @param props.className - Additional CSS classes
 */

"use client";

import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../button";
import { Slider } from "../slider";

interface VoiceAudioPlayerProps {
  audioUrl: string;
  className?: string;
}

interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
}

export function VoiceAudioPlayer({ audioUrl, className }: VoiceAudioPlayerProps) {
  const [playerState, setPlayerState] = useState<PlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    isMuted: false,
  });
  const audioRef = useRef<HTMLAudioElement>(null);

  const updatePlayer = useCallback((updates: Partial<PlayerState>) => {
    setPlayerState((prev) => ({ ...prev, ...updates }));
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => updatePlayer({ currentTime: audio.currentTime });
    const handleDurationChange = () => updatePlayer({ duration: audio.duration });
    const handleEnded = () => updatePlayer({ isPlaying: false });

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("durationchange", handleDurationChange);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("durationchange", handleDurationChange);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [updatePlayer]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (playerState.isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
    updatePlayer({ isPlaying: !playerState.isPlaying });
  };

  const handleSeek = (value: number[]) => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.currentTime = value[0];
    updatePlayer({ currentTime: value[0] });
  };

  const handleVolumeChange = (value: number[]) => {
    const audio = audioRef.current;
    if (!audio) return;

    const newVolume = value[0];
    audio.volume = newVolume;
    updatePlayer({ volume: newVolume, isMuted: newVolume === 0 });
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (playerState.isMuted) {
      audio.volume = playerState.volume || 0.5;
      updatePlayer({ isMuted: false });
    } else {
      audio.volume = 0;
      updatePlayer({ isMuted: true });
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <audio ref={audioRef} src={audioUrl} preload="metadata">
        <track kind="captions" />
      </audio>

      <Button variant="outline" size="icon" onClick={togglePlay} className="h-8 w-8">
        {playerState.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>

      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatTime(playerState.currentTime)}
        </span>
        <Slider
          value={[playerState.currentTime]}
          max={playerState.duration || 100}
          step={0.1}
          onValueChange={handleSeek}
          className="flex-1"
        />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatTime(playerState.duration)}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={toggleMute} className="h-8 w-8">
          {playerState.isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </Button>
        <Slider
          value={[playerState.isMuted ? 0 : playerState.volume]}
          max={1}
          step={0.01}
          onValueChange={handleVolumeChange}
          className="w-20"
        />
      </div>
    </div>
  );
}
