import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { useEffect, useState } from 'react';

function ElizaWrapper() {
  const [status, setStatus] = useState<'starting' | 'running' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [isServerAccessible, setIsServerAccessible] = useState(false);

  const checkServerAccessibility = async (): Promise<boolean> => {
    const response = await fetch('http://localhost:3000', {
      method: 'HEAD',
      mode: 'no-cors',
    });
    return response.type === 'opaque' || response.status === 0;
  };

  useEffect(() => {
    let checkInterval: ReturnType<typeof setInterval> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const startServer = async () => {
      setStatus('running');

      checkInterval = setInterval(async () => {
        const isAccessible = await checkServerAccessibility();
        if (isAccessible) {
          setIsServerAccessible(true);
          clearInterval(checkInterval);
          clearTimeout(timeoutId);
        }
      }, 1000);

      timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
      }, 60000);
    };

    startServer().catch((err: Error) => {
      console.error('Failed to start Eliza server:', err);
      setStatus('error');
      setError(`Failed to start Eliza server: ${err.message}`);
    });

    return () => {
      clearInterval(checkInterval);
      clearTimeout(timeoutId);
    };
  }, [retryCount]);

  const handleRetry = () => {
    setStatus('starting');
    setError(null);
    setRetryCount((prev) => prev + 1);
  };

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

const rootElement = document.getElementById('root');
ReactDOM.createRoot(rootElement!).render(
  <StrictMode>
    <ElizaWrapper />
  </StrictMode>
);
