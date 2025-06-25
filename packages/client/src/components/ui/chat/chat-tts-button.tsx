import { useToast } from '@/hooks/use-toast';
import { createElizaClient } from '@/lib/api-client-config';
import { UUID } from '@elizaos/core';
import { useMutation } from '@tanstack/react-query';
import { Ellipsis, StopCircle, Volume2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

export default function ChatTtsButton({ agentId, text }: { agentId: string; text: string }) {
  const { toast } = useToast();
  const [playing, setPlaying] = useState<boolean>(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const elizaClient = createElizaClient();
  const mutation = useMutation({
    mutationKey: ['tts', text],
    mutationFn: async () => {
      const response = await elizaClient.audio.generateSpeech(agentId as UUID, { text });

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
      play();
    },
    onError: (e) => {
      toast({
        variant: 'destructive',
        title: 'Unable to read message aloud',
        description: e.message,
      });
    },
  });

  const play = () => {
    if (audioRef.current) {
      audioRef.current.play().catch((err) => {
        console.error('Error playing audio:', err);
      });
    }
    setPlaying(true);
  };

  const stop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlaying(false);
  };

  const execute = () => {
    if (mutation?.isPending) return;

    if (playing) {
      stop();
      return;
    }

    if (audioBlob) {
      play();
      return;
    }

    mutation.mutate();
  };

  const iconClass = 'text-muted-foreground size-4';

  return (
    <div>
      {audioBlob ? (
        <audio
          crossOrigin="anonymous"
          playsInline
          ref={audioRef}
          onEnded={() => {
            setPlaying(false);
          }}
          autoPlay
        >
          <source src={URL.createObjectURL(audioBlob)} type={audioBlob.type} />
          <track kind="captions" src="" label="English captions" />
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
    </div>
  );
}
