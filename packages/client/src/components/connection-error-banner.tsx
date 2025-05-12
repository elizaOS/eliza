import { AlertCircle, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useConnection } from '../context/ConnectionContext';

export interface ConnectionErrorBannerProps {
  className?: string;
}

export function ConnectionErrorBanner({ className }: ConnectionErrorBannerProps) {
  const { status, error } = useConnection();

  const shouldShowBanner = status === 'error' || status === 'unauthorized';

  if (!shouldShowBanner) {
    return null;
  }

  let errorTitle = 'Connection Failed';
  let errorDescription = 'Please ensure the Eliza server is running and accessible.';
  const isUnauthorized = status === 'unauthorized';

  if (error) {
    const errorMsg = error;

    if (isUnauthorized) {
      errorTitle = 'Unauthorized';
      errorDescription = 'Invalid or missing API Key provided.';
    } else if (errorMsg.includes('NetworkError') || errorMsg.includes('Failed to fetch')) {
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
      errorMsg.includes('API endpoint not found') ||
      errorMsg.includes('Endpoint not found')
    ) {
      errorTitle = 'Endpoint Not Found';
      errorDescription = 'The server API endpoint could not be found.';
    } else {
      // Use the provided error message directly for other cases
      errorDescription = errorMsg;
    }
  }

  return (
    <div
      className={cn(
        'bg-opacity-10 border rounded-md p-3 mb-4 w-full md:max-w-4xl',
        'flex items-center justify-between w-full mt-4',
        isUnauthorized
          ? 'bg-yellow-900/20 border-yellow-700 text-yellow-100'
          : 'bg-red-900/20 border-red-700 text-red-100',
        className
      )}
    >
      <div className="flex items-center space-x-3">
        <AlertCircle
          className={cn(
            'h-5 w-5 flex-shrink-0',
            isUnauthorized ? 'text-yellow-400' : 'text-red-400'
          )}
        />
        <div>
          <h4
            className={cn(
              'font-medium text-sm',
              isUnauthorized ? 'text-yellow-200' : 'text-red-200'
            )}
          >
            {errorTitle}
          </h4>
          <p className={cn('text-xs mt-1', isUnauthorized ? 'text-yellow-300' : 'text-red-300')}>
            {errorDescription}
          </p>
          <div className="mt-2 flex space-x-4">
            <a
              href="https://eliza.how"
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'text-xs flex items-center',
                isUnauthorized
                  ? 'hover:text-yellow-200 text-yellow-300'
                  : 'hover:text-red-200 text-red-300'
              )}
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              Troubleshooting Guide
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
