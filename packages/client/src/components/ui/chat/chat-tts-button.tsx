import { useToast } from '@/hooks/use-toast';
import { createElizaClient } from '@/lib/api-client-config';
import { UUID } from '@elizaos/core';
import { useMutation } from '@tanstack/react-query';
import { Ellipsis, StopCircle, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

// Global ref to track currently playing audio
let currentlyPlayingAudio: HTMLAudioElement | null = null;

export default function ChatTtsButton({ agentId, text }: { agentId: string; text: string }) {
  const { toast } = useToast();
  const [playing, setPlaying] = useState<boolean>(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioBlobRef = useRef<Blob | null>(null);

  const elizaClient = createElizaClient();

  // Cleanup blob URL when component unmounts or audioBlob changes
  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const mutation = useMutation({
    mutationKey: ['tts', text],
    mutationFn: async () => {
      console.log('🎵 Starting TTS API call...');
      console.log('🎵 agentId:', agentId);
      console.log('🎵 text:', text);

      const response = await elizaClient.audio.generateSpeech(agentId as UUID, { text });
      console.log('🎵 TTS API response:', response);

      // Convert base64 audio string to Blob
      const { audio, format } = response;

      // Handle data URL format (data:audio/mp3;base64,...)
      let audioData: string;
      let mimeType: string;

      if (audio.startsWith('data:')) {
        const [header, base64Data] = audio.split(',');
        const mimeMatch = header.match(/data:([^;]+)/);
        mimeType = mimeMatch ? mimeMatch[1] : `audio/${format || 'mpeg'}`;
        audioData = base64Data;
      } else {
        // Plain base64 string
        audioData = audio;
        mimeType = `audio/${format || 'mpeg'}`;
      }

      // Convert base64 to Blob
      const binaryString = atob(audioData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      return new Blob([bytes], { type: mimeType });
    },
    onSuccess: (data: Blob) => {
      setAudioBlob(data);
      audioBlobRef.current = data;
      const url = URL.createObjectURL(data);
      setAudioUrl(url);

      // Auto-play after TTS generation
      setTimeout(() => {
        play();
      }, 100);
    },
    onError: (e) => {
      toast({
        variant: 'destructive',
        title: 'Unable to read message aloud',
        description: e.message,
      });
    },
  });

  const play = async () => {
    if (audioRef.current) {
      try {
        // Stop any currently playing audio
        if (currentlyPlayingAudio && currentlyPlayingAudio !== audioRef.current) {
          currentlyPlayingAudio.pause();
          currentlyPlayingAudio.currentTime = 0;
        }

        // Set this as the currently playing audio
        currentlyPlayingAudio = audioRef.current;

        audioRef.current.volume = 1.0;
        audioRef.current.muted = false;

        await audioRef.current.play();
        setPlaying(true);
      } catch (err) {
        toast({
          variant: 'destructive',
          title: 'Audio playback failed',
          description: (err as Error).message,
        });
        setPlaying(false);
      }
    }
  };

  const stop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;

      // Clear global reference if this was the currently playing audio
      if (currentlyPlayingAudio === audioRef.current) {
        currentlyPlayingAudio = null;
      }
    }
    setPlaying(false);
  };

  const execute = async () => {
    if (mutation?.isPending) {
      return;
    }

    if (playing) {
      stop();
      return;
    }

    // Check if audio is already available
    const hasAudioBlob =
      audioBlob ||
      audioBlobRef.current ||
      (audioRef.current?.src && audioRef.current.src.startsWith('blob:'));
    if (hasAudioBlob) {
      await play();
      return;
    }

    // Generate TTS
    mutation.mutate();
  };

  const iconClass = 'text-muted-foreground size-3';

  return (
    <>
      {audioBlob ? (
        <audio
          crossOrigin="anonymous"
          playsInline
          ref={audioRef}
          src={audioUrl || ''}
          onEnded={() => {
            setPlaying(false);
            // Clear global reference when audio ends
            if (currentlyPlayingAudio === audioRef.current) {
              currentlyPlayingAudio = null;
            }
          }}
        >
          Your browser does not support the audio element.
        </audio>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            type="button"
            onClick={() => execute()}
            disabled={mutation?.isPending}
          >
            {mutation?.isPending ? (
              <Ellipsis className={iconClass} />
            ) : playing ? (
              <StopCircle className={iconClass} />
            ) : (
              <Volume2 className={iconClass} />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{playing ? 'Stop' : 'Read aloud'}</p>
        </TooltipContent>
      </Tooltip>
    </>
  );
}
