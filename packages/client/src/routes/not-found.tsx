import { AlertCircle, Home, ArrowLeft } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  const location = useLocation();
  const path = location.pathname;

  // Determine if this is likely an API endpoint that doesn't exist
  const isLikelyApiEndpoint =
    path.startsWith('/api/') ||
    path.includes('/agents/') ||
    path.includes('/memory/') ||
    path.includes('/speech/');

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] px-4 text-center">
      <div className="flex items-center justify-center mb-8">
        <div className="bg-red-900/20 h-24 w-24 rounded-full flex items-center justify-center">
          <AlertCircle className="h-14 w-14 text-red-500" />
        </div>
      </div>

      <h1 className="text-3xl font-bold mb-2">Page Not Found</h1>

      <div className="max-w-lg">
        {isLikelyApiEndpoint ? (
          <>
            <p className="text-lg mb-6 text-muted-foreground">
              The endpoint <span className="font-mono text-red-400">{path}</span> does not exist.
            </p>
            <div className="bg-red-900/20 border border-red-800/30 rounded-md p-4 mb-8 text-left">
              <h3 className="text-red-400 font-medium mb-2 flex items-center">
                <AlertCircle className="h-4 w-4 mr-2" />
                Endpoint Not Found
              </h3>
              <p className="text-sm text-red-300/80 mb-2">
                The requested API endpoint does not exist on this server. Please check that:
              </p>
              <ul className="text-sm text-red-300/80 list-disc pl-5 space-y-1">
                <li>The URL is spelled correctly</li>
                <li>You're using the correct version of the API</li>
                <li>The endpoint is available in this version of Eliza</li>
              </ul>
            </div>
          </>
        ) : (
          <p className="text-lg mb-6 text-muted-foreground">
            Sorry, the page you're looking for doesn't exist or has been moved.
          </p>
        )}

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button asChild variant="default">
            <Link to="/">
              <Home className="h-4 w-4 mr-2" />
              Go to Home
            </Link>
          </Button>

          <Button asChild variant="outline">
            <a onClick={() => window.history.back()}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Go Back
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
