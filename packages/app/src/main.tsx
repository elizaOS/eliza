import React from 'react';
import ReactDOM from 'react-dom/client';
// Using a simple try/catch for the Eliza server, avoiding Tauri API dependencies
import { useEffect, useState } from 'react';

// Component that will redirect the user to the Eliza client
function ElizaWrapper() {
  const [status, setStatus] = useState<'starting' | 'running' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [isServerAccessible, setIsServerAccessible] = useState(false);

  // Function to check if server is accessible
  const checkServerAccessibility = async () => {
    try {
      await fetch('http://localhost:3000', {
        method: 'HEAD',
        mode: 'no-cors', // Just checking if we can connect, not actually getting a response
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  // Start the Eliza server
  useEffect(() => {
    const startServer = async () => {
      try {
        setStatus('running');

        // Start polling to check if the server is accessible
        const checkInterval = setInterval(async () => {
          const isAccessible = await checkServerAccessibility();
          if (isAccessible) {
            setIsServerAccessible(true);
            clearInterval(checkInterval);
          }
        }, 1000);

        // Clear interval after 60 seconds to prevent infinite polling
        setTimeout(() => clearInterval(checkInterval), 60000);
      } catch (err: unknown) {
        console.error('Failed to start Eliza server:', err);
        setStatus('error');
        setError(
          `Failed to start Eliza server: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    startServer();
  }, [retryCount]); // Dependency on retryCount allows us to retry

  // Retry handler
  const handleRetry = () => {
    setStatus('starting');
    setError(null);
    setRetryCount((prev) => prev + 1);
  };

  // If the server is running and accessible, show the iframe
  if (status === 'running' && isServerAccessible) {
    return (
      <div style={{ width: '100%', height: '100vh', margin: 0, padding: 0 }}>
        <iframe
          src="http://localhost:3000"
          title="Eliza Client"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
          }}
        />
      </div>
    );
  }

  // Show loading or error message
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        padding: '20px',
        textAlign: 'center',
        fontFamily: 'sans-serif',
      }}
    >
      {status === 'error' ? (
        <>
          <h2 style={{ color: 'red' }}>Error</h2>
          <p>{error}</p>
          <button
            type="button"
            onClick={handleRetry}
            style={{
              marginTop: '20px',
              padding: '10px 20px',
              backgroundColor: '#0078d7',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '16px',
            }}
          >
            Retry
          </button>
        </>
      ) : (
        <>
          <h2>Starting Eliza Server...</h2>
          <p>Please wait while we start the backend services.</p>
          <div
            style={{
              marginTop: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                border: '2px solid #ccc',
                borderTopColor: '#0078d7',
                animation: 'spin 1s linear infinite',
              }}
            />
            <style>
              {`
                @keyframes spin {
                  to { transform: rotate(360deg); }
                }
              `}
            </style>
          </div>
        </>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ElizaWrapper />
  </React.StrictMode>
);
