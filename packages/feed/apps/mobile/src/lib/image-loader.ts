const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || 'https://play.babylon.market';

export default function imageLoader({
  src,
}: {
  src: string;
  width: number;
  quality?: number;
}) {
  // Remote URLs — pass through unchanged
  if (src.startsWith('http://') || src.startsWith('https://')) {
    return src;
  }
  // Local static assets — serve from the web app's deployment
  return `${API_BASE}${src}`;
}
