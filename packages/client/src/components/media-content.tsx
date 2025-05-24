import { useState } from 'react';
import { Play, Volume2, FileText, ExternalLink, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MediaContentProps {
  url: string;
  title?: string;
  className?: string;
  maxWidth?: number;
  maxHeight?: number;
}

// Utility functions to detect media types
const getYouTubeId = (url: string): string | null => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
};

const getSpotifyId = (url: string): { type: string; id: string } | null => {
  const match = url.match(/spotify\.com\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/);
  if (match) {
    return { type: match[1], id: match[2] };
  }
  return null;
};

const isImageUrl = (url: string): boolean => {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(url);
};

const isVideoUrl = (url: string): boolean => {
  return /\.(mp4|webm|ogg|mov|avi|wmv|flv|mkv)(\?.*)?$/i.test(url);
};

const isAudioUrl = (url: string): boolean => {
  return /\.(mp3|wav|ogg|aac|flac|m4a|wma)(\?.*)?$/i.test(url);
};

const isPdfUrl = (url: string): boolean => {
  return /\.pdf(\?.*)?$/i.test(url) || url.includes('pdf');
};

const isDocumentUrl = (url: string): boolean => {
  return /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|txt)(\?.*)?$/i.test(url);
};

export default function MediaContent({
  url,
  title,
  className,
  maxWidth = 600,
  maxHeight = 400,
}: MediaContentProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const handleLoad = () => setIsLoading(false);
  const handleError = () => {
    setIsLoading(false);
    setHasError(true);
  };

  // YouTube Video
  const youtubeId = getYouTubeId(url);
  if (youtubeId) {
    return (
      <div
        className={cn('relative rounded-lg overflow-hidden bg-gray-100', className)}
        style={{ maxWidth, maxHeight }}
      >
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
            <div className="flex items-center space-x-2 text-gray-500">
              <Play className="w-6 h-6" />
              <span>Loading video...</span>
            </div>
          </div>
        )}
        <iframe
          src={`https://www.youtube.com/embed/${youtubeId}`}
          title={title || 'YouTube video'}
          className="w-full aspect-video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          onLoad={handleLoad}
          onError={handleError}
        />
      </div>
    );
  }

  // Spotify Content
  const spotifyData = getSpotifyId(url);
  if (spotifyData) {
    const height = spotifyData.type === 'track' ? 152 : spotifyData.type === 'episode' ? 232 : 352;
    return (
      <div
        className={cn('relative rounded-lg overflow-hidden bg-gray-100', className)}
        style={{ maxWidth }}
      >
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
            <div className="flex items-center space-x-2 text-gray-500">
              <Volume2 className="w-6 h-6" />
              <span>Loading Spotify content...</span>
            </div>
          </div>
        )}
        <iframe
          src={`https://open.spotify.com/embed/${spotifyData.type}/${spotifyData.id}?utm_source=generator`}
          width="100%"
          height={height}
          frameBorder="0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
          title={title || 'Spotify content'}
          onLoad={handleLoad}
          onError={handleError}
        />
      </div>
    );
  }

  // Direct Image
  if (isImageUrl(url)) {
    return (
      <div
        className={cn('relative rounded-lg overflow-hidden bg-gray-100', className)}
        style={{ maxWidth, maxHeight }}
      >
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
            <div className="animate-pulse w-full h-32 bg-gray-200 rounded" />
          </div>
        )}
        {hasError ? (
          <div className="flex items-center justify-center p-4 text-gray-500">
            <AlertCircle className="w-6 h-6 mr-2" />
            <span>Failed to load image</span>
          </div>
        ) : (
          <img
            src={url || '/placeholder.svg'}
            alt={title || 'Image'}
            width={maxWidth}
            height={maxHeight}
            className="w-full h-auto object-contain"
            onLoad={handleLoad}
            onError={handleError}
            crossOrigin="anonymous"
          />
        )}
      </div>
    );
  }

  // Direct Video
  if (isVideoUrl(url)) {
    return (
      <div
        className={cn('relative rounded-lg overflow-hidden bg-gray-100', className)}
        style={{ maxWidth, maxHeight }}
      >
        {hasError ? (
          <div className="flex items-center justify-center p-4 text-gray-500">
            <AlertCircle className="w-6 h-6 mr-2" />
            <span>Failed to load video</span>
          </div>
        ) : (
          <video
            controls
            preload="metadata"
            className="w-full h-auto"
            onLoadedData={handleLoad}
            onError={handleError}
            crossOrigin="anonymous"
          >
            <source src={url} />
            Your browser does not support the video tag.
          </video>
        )}
      </div>
    );
  }

  // Direct Audio
  if (isAudioUrl(url)) {
    return (
      <div
        className={cn('relative rounded-lg bg-gray-50 border p-4', className)}
        style={{ maxWidth }}
      >
        <div className="flex items-center space-x-3 mb-3">
          <Volume2 className="w-5 h-5 text-gray-600" />
          <span className="text-sm font-medium text-gray-700">{title || 'Audio File'}</span>
        </div>
        {hasError ? (
          <div className="flex items-center text-gray-500">
            <AlertCircle className="w-4 h-4 mr-2" />
            <span className="text-sm">Failed to load audio</span>
          </div>
        ) : (
          <audio
            controls
            className="w-full"
            preload="metadata"
            onLoadedData={handleLoad}
            onError={handleError}
            crossOrigin="anonymous"
          >
            <source src={url} />
            Your browser does not support the audio tag.
          </audio>
        )}
      </div>
    );
  }

  // PDF Document
  if (isPdfUrl(url)) {
    return (
      <div
        className={cn('relative rounded-lg overflow-hidden bg-gray-100 border', className)}
        style={{ maxWidth }}
      >
        <div className="flex items-center justify-between p-3 bg-gray-50 border-b">
          <div className="flex items-center space-x-2">
            <FileText className="w-5 h-5 text-gray-600" />
            <span className="text-sm font-medium text-gray-700">{title || 'PDF Document'}</span>
          </div>
          <div className="flex items-center space-x-2">
            <a
              href={`https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center space-x-1 text-blue-600 hover:text-blue-800 text-sm"
            >
              <ExternalLink className="w-4 h-4" />
              <span>View</span>
            </a>
            <a
              href={url}
              download
              className="flex items-center space-x-1 text-green-600 hover:text-green-800 text-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <span>Download</span>
            </a>
          </div>
        </div>

        {/* Try multiple PDF viewing methods */}
        <div className="relative" style={{ height: Math.min(maxHeight, 500) }}>
          {hasError ? (
            <div className="flex flex-col items-center justify-center p-8 text-gray-500 h-full">
              <AlertCircle className="w-8 h-8 mb-2" />
              <span className="text-center mb-4">PDF preview not available</span>
              <div className="flex space-x-2">
                <a
                  href={`https://docs.google.com/viewer?url=${encodeURIComponent(url)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 bg-blue-500 text-white rounded text-sm hover:bg-blue-600"
                >
                  Open in Google Viewer
                </a>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 bg-gray-500 text-white rounded text-sm hover:bg-gray-600"
                >
                  Open Original
                </a>
              </div>
            </div>
          ) : (
            <>
              {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
                  <div className="flex items-center space-x-2 text-gray-500">
                    <FileText className="w-6 h-6" />
                    <span>Loading PDF...</span>
                  </div>
                </div>
              )}

              {/* Try Google Docs Viewer first */}
              <iframe
                src={`https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`}
                className="w-full h-full border-0"
                title={title || 'PDF Document'}
                onLoad={handleLoad}
                onError={() => {
                  // Fallback to direct PDF if Google Viewer fails
                  const iframe = document.createElement('iframe');
                  iframe.src = `${url}#toolbar=0&navpanes=0&scrollbar=0`;
                  iframe.className = 'w-full h-full border-0';
                  iframe.title = title || 'PDF Document';
                  iframe.onload = handleLoad;
                  iframe.onerror = handleError;

                  const container = document.querySelector(`[data-pdf-container="${url}"]`);
                  if (container) {
                    container.innerHTML = '';
                    container.appendChild(iframe);
                  }
                }}
              />

              <div data-pdf-container={url} className="hidden" />
            </>
          )}
        </div>

        {/* PDF Info Footer */}
        <div className="p-2 bg-gray-50 border-t text-xs text-gray-500">
          <span>PDF Document • Click "View" or "Download" if preview doesn't load</span>
        </div>
      </div>
    );
  }

  // Other Documents
  if (isDocumentUrl(url)) {
    return (
      <div className={cn('rounded-lg bg-gray-50 border p-4', className)} style={{ maxWidth }}>
        <div className="flex items-center space-x-3">
          <FileText className="w-8 h-8 text-gray-600" />
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-700">{title || 'Document'}</p>
            <p className="text-xs text-gray-500">{url.split('.').pop()?.toUpperCase()} file</p>
          </div>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center space-x-1 text-blue-600 hover:text-blue-800 text-sm font-medium"
          >
            <ExternalLink className="w-4 h-4" />
            <span>Open</span>
          </a>
        </div>
      </div>
    );
  }

  // Fallback for unknown URLs
  return (
    <div className={cn('rounded-lg bg-gray-50 border p-4', className)} style={{ maxWidth }}>
      <div className="flex items-center space-x-3">
        <ExternalLink className="w-8 h-8 text-gray-600" />
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-700">{title || 'External Link'}</p>
          <p className="text-xs text-gray-500 truncate">{url}</p>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center space-x-1 text-blue-600 hover:text-blue-800 text-sm font-medium"
        >
          <ExternalLink className="w-4 h-4" />
          <span>Open</span>
        </a>
      </div>
    </div>
  );
}
