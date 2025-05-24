/**
 * Components for displaying images and videos in chat messages
 */

import { Button } from '@/components/ui/button';
import { parseMediaFromText } from '@/lib/media-utils';
import { cn } from '@/lib/utils';
import { ExternalLink, Play } from 'lucide-react';
import { useState } from 'react';

interface ImageContentProps {
  url: string;
  alt?: string;
  className?: string;
}

export function ImageContent({ url, alt = 'Image', className }: ImageContentProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const handleLoad = () => setIsLoading(false);
  const handleError = () => {
    setIsLoading(false);
    setHasError(true);
  };

  if (hasError) {
    return (
      <div className={cn('flex items-center gap-2 p-3 border rounded-lg', className)}>
        <span className="text-sm">Failed to load image</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => window.open(url, '_blank')}
          className="h-auto p-1"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('relative rounded-lg overflow-hidden', className)}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-lg">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
        </div>
      )}
      <img
        src={url}
        alt={alt}
        onLoad={handleLoad}
        onError={handleError}
        className={cn(
          'max-w-full h-auto rounded-lg cursor-pointer transition-opacity',
          isLoading ? 'opacity-0' : 'opacity-100'
        )}
        style={{ maxHeight: '400px', maxWidth: '300px' }}
        onClick={() => window.open(url, '_blank')}
      />
    </div>
  );
}

interface VideoContentProps {
  url: string;
  isEmbed?: boolean;
  className?: string;
}

export function VideoContent({ url, isEmbed = false, className }: VideoContentProps) {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return (
      <div className={cn('flex items-center gap-2 p-3 border rounded-lg bg-muted/50', className)}>
        <span className="text-sm text-muted-foreground">Failed to load video</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => window.open(url, '_blank')}
          className="h-auto p-1"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  if (isEmbed) {
    // Embedded video (YouTube, Vimeo, etc.)
    return (
      <div className={cn('relative rounded-lg overflow-hidden', className)}>
        <iframe
          src={url}
          className="w-full h-64 rounded-lg"
          frameBorder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          onError={() => setHasError(true)}
        />
      </div>
    );
  }

  // Direct video file
  return (
    <div className={cn('relative rounded-lg overflow-hidden', className)}>
      <video
        src={url}
        controls
        className="max-w-full h-auto rounded-lg"
        style={{ maxHeight: '400px', maxWidth: '300px' }}
        onError={() => setHasError(true)}
      >
        <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/50">
          <Play className="h-4 w-4" />
          <span className="text-sm">Video not supported</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.open(url, '_blank')}
            className="h-auto p-1"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
        </div>
      </video>
    </div>
  );
}

interface MediaContentProps {
  text: string;
  className?: string;
}

export function MediaContent({ text, className }: MediaContentProps) {
  if (!text) return null;

  // Parse media from the text
  const mediaInfos = parseMediaFromText(text);

  if (mediaInfos.length === 0) return null;

  return (
    <div className={cn('space-y-3', className)}>
      {mediaInfos.map((media, index) => {
        if (media.type === 'image') {
          return (
            <ImageContent
              key={`${media.url}-${index}`}
              url={media.url}
              alt={`Image ${index + 1}`}
            />
          );
        } else if (media.type === 'video') {
          return (
            <VideoContent key={`${media.url}-${index}`} url={media.url} isEmbed={media.isEmbed} />
          );
        }
        return null;
      })}
    </div>
  );
}
