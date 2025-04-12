import { AlertCircle, CheckCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export interface ConnectionErrorBannerProps {
  className?: string;
  testEndpoint?: string; // Optional endpoint to test instead of ping
}

export function ConnectionErrorBanner({ className, testEndpoint }: ConnectionErrorBannerProps) {
  const location = useLocation();
  const [dismissed, setDismissed] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const [showBanner, setShowBanner] = useState(false);
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);
  const [wasInErrorState, setWasInErrorState] = useState(false);
  const [autoDetectedEndpoint, setAutoDetectedEndpoint] = useState<string | null>(null);

  // Auto-detect if the current URL path looks like an API endpoint
  useEffect(() => {
    const path = location.pathname;

    // Check if this looks like a mistyped API endpoint in the browser URL
    const isLikelyApiEndpoint =
      path.startsWith('/api/') ||
      (path.includes('/agents/') && path.includes('/speech/')) ||
      (path.includes('/agents/') && path.includes('/memories/')) ||
      path.includes('/transcriptions/') ||
      path.includes('/ping/');

    if (isLikelyApiEndpoint) {
      // Convert browser URL to API endpoint format by stripping leading slash
      const endpoint = path.startsWith('/api/') ? path.substring(4) : path;
      setAutoDetectedEndpoint(endpoint);
    } else {
      setAutoDetectedEndpoint(null);
    }
  }, [location.pathname]);

  // Use the detected endpoint or the provided one
  const endpointToTest = autoDetectedEndpoint || testEndpoint;

  // Use the query to check connection status - either ping or a custom endpoint
  const query = useQuery({
    queryKey: ['connection-test', endpointToTest],
    queryFn: async () => {
      if (endpointToTest) {
        return await apiClient.testEndpoint(endpointToTest);
      }
      return await apiClient.ping();
    },
    refetchInterval: autoDetectedEndpoint ? false : 10000, // Only poll for standard connection checks
    retry: 1,
    staleTime: 5000,
    // Don't run this query if we're just displaying the regular connection status
    enabled: !!endpointToTest || !autoDetectedEndpoint,
  });

  // Only show the banner after multiple consecutive failures to avoid disrupting the UI for brief network blips
  // But if we auto-detected an endpoint, show errors immediately
  useEffect(() => {
    if (query.isError) {
      setErrorCount((prev) => prev + 1);
      setWasInErrorState(true);

      // Show banner immediately for auto-detected endpoints
      if (autoDetectedEndpoint) {
        setShowBanner(true);
      }
    } else if (query.isSuccess) {
      // If we were in an error state and now we're successful, show the success banner
      if (wasInErrorState && errorCount >= 2) {
        setShowSuccessBanner(true);
        // Hide the success banner after 3 seconds
        setTimeout(() => {
          setShowSuccessBanner(false);
        }, 3000);
      }

      setErrorCount(0);
      setShowBanner(false);
      // Only reset wasInErrorState after the success message disappears
      if (!showSuccessBanner) {
        setWasInErrorState(false);
      }
    }

    // Show banner after 2 consecutive errors (indicating a persistent issue)
    // or immediately for auto-detected endpoints
    if ((errorCount >= 2 || autoDetectedEndpoint) && !dismissed && query.isError) {
      setShowBanner(true);
    }
  }, [query.status, dismissed, errorCount, wasInErrorState, autoDetectedEndpoint]);

  // Reset dismissed state when connection is reestablished
  useEffect(() => {
    if (query.isSuccess && dismissed) {
      setDismissed(false);
    }
  }, [query.isSuccess, dismissed]);

  const handleRefresh = () => {
    query.refetch();
  };

  const handleDismiss = () => {
    setDismissed(true);
    setShowBanner(false);
  };

  if (!showBanner && !showSuccessBanner) {
    return null;
  }

  // If showing success banner
  if (showSuccessBanner && !showBanner) {
    return (
      <div
        className={cn(
          'bg-green-900/20 border border-green-700 text-green-100 rounded-md p-3 mb-4',
          'flex items-center justify-between',
          className
        )}
      >
        <div className="flex items-center space-x-3">
          <CheckCircle className="h-5 w-5 text-green-400 flex-shrink-0" />
          <div>
            <h4 className="font-medium text-sm text-green-200">Connection Restored</h4>
            <p className="text-xs text-green-300 mt-1">
              Successfully reconnected to the Eliza server.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Build a more specific error message based on the error type
  let errorTitle = 'Connection Failed';
  let errorDescription = 'Please ensure the Eliza server is running and accessible.';

  if (query.error instanceof Error) {
    const errorMsg = query.error.message;
    if (errorMsg.includes('NetworkError') || errorMsg.includes('Failed to fetch')) {
      errorTitle = 'Network Error';
      errorDescription = 'Cannot reach the server. Please check your network connection.';
    } else if (errorMsg.includes('ECONNREFUSED')) {
      errorTitle = 'Connection Refused';
      errorDescription = 'The server refused the connection. Please ensure it is running.';
    } else if (errorMsg.includes('timeout')) {
      errorTitle = 'Connection Timeout';
      errorDescription = 'The server took too long to respond.';
    } else if (
      errorMsg.includes('404') ||
      errorMsg.includes('not found') ||
      errorMsg.includes('API endpoint not found')
    ) {
      errorTitle = 'Endpoint Not Found';
      const endpoint = autoDetectedEndpoint || testEndpoint;
      if (endpoint) {
        errorDescription = `The requested endpoint "${endpoint}" does not exist on the server.`;
      } else {
        errorDescription = 'The requested API endpoint does not exist.';
      }
    }
  }

  return (
    <div
      className={cn(
        'bg-red-900/20 border border-red-700 text-red-100 rounded-md p-3 mb-4',
        'flex items-center justify-between',
        className
      )}
    >
      <div className="flex items-center space-x-3">
        <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0" />
        <div>
          <h4 className="font-medium text-sm text-red-200">{errorTitle}</h4>
          <p className="text-xs text-red-300 mt-1">{errorDescription}</p>
          <div className="mt-2 flex space-x-4">
            <a
              href="https://elizaos.github.io/eliza/docs/troubleshooting"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs flex items-center hover:text-red-200 text-red-300"
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              Troubleshooting Guide
            </a>
            <button
              onClick={handleRefresh}
              className="text-xs flex items-center hover:text-red-200 text-red-300"
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Retry Connection
            </button>
          </div>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDismiss}
        className="h-8 text-red-400 hover:text-red-300 hover:bg-red-900/30"
      >
        Dismiss
      </Button>
    </div>
  );
}
