import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AgentCreator from './components/agent-creator';
import { AppSidebar } from './components/app-sidebar';
import { ConnectionErrorBanner } from './components/connection-error-banner';
import EnvSettings from './components/env-settings';
import { AgentLogViewer } from './components/agent-log-viewer';
import OnboardingTour from './components/onboarding-tour';
import { Toaster } from './components/ui/toaster';
import { TooltipProvider } from './components/ui/tooltip';
import { AuthProvider } from './context/AuthContext';
import { ConnectionProvider, useConnection } from './context/ConnectionContext';
import { STALE_TIMES } from './hooks/use-query-hooks';
import useVersion from './hooks/use-version';
import './index.css';
import { apiClient } from './lib/api';
import Chat from './routes/chat';
import AgentCreatorRoute from './routes/createAgent';
import Home from './routes/home';
import NotFound from './routes/not-found';
import Room from './routes/room';
import Settings from './routes/settings';

// Create a query client with optimized settings
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_TIMES.STANDARD,
      // Default to no polling unless specifically configured
      refetchInterval: false,
      // Make queries retry 3 times with exponential backoff
      retry: 3,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      // Refetch query on window focus
      refetchOnWindowFocus: true,
      // Enable refetch on reconnect
      refetchOnReconnect: true,
      // Fail queries that take too long
    },
    mutations: {
      // Default to 3 retries for mutations too
      retry: 3,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    },
  },
});

// Prefetch initial data with smarter error handling
const prefetchInitialData = async () => {
  try {
    // Prefetch agents (real-time data so shorter stale time)
    await queryClient.prefetchQuery({
      queryKey: ['agents'],
      queryFn: () => apiClient.getAgents(),
      staleTime: STALE_TIMES.FREQUENT,
    });
  } catch (error) {
    console.error('Error prefetching initial data:', error);
    // Don't throw, let the app continue loading with fallbacks
  }
};

// Execute prefetch immediately
prefetchInitialData();

// Component containing the core application logic and routing
function AppContent() {
  useVersion();
  const { status } = useConnection();

  // Also prefetch when the component mounts (helps with HMR and refreshes)
  useEffect(() => {
    prefetchInitialData();
  }, []);

  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <div className="flex w-full justify-center">
            <div className="w-full md:max-w-4xl">
              <ConnectionErrorBanner />
            </div>
          </div>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="chat/:agentId" element={<Chat />} />
            <Route path="settings/:agentId" element={<Settings />} />
            <Route path="agents/new" element={<AgentCreatorRoute />} />
            <Route path="/create" element={<AgentCreator />} />
            <Route
              path="/logs"
              element={
                <div className="flex w-full justify-center">
                  <div className="w-full md:max-w-4xl">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-2xl p-4 font-bold">System Logs</h2>
                    </div>
                    <AgentLogViewer />
                  </div>
                </div>
              }
            />
            <Route path="room/:serverId" element={<Room />} />
            <Route
              path="settings/"
              element={
                <div className="flex w-full justify-center">
                  <div className="w-full md:max-w-4xl">
                    <EnvSettings />
                  </div>
                </div>
              }
            />
            {/* Catch-all route for 404 errors */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
      {status !== 'unauthorized' && <OnboardingTour />}
    </TooltipProvider>
  );
}

// Main App component setting up providers
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div
        className="dark antialiased font-sans"
        style={{
          colorScheme: 'dark',
        }}
      >
        <BrowserRouter>
          <AuthProvider>
            <ConnectionProvider>
              <AppContent />
            </ConnectionProvider>
          </AuthProvider>
        </BrowserRouter>
      </div>
    </QueryClientProvider>
  );
}

export default App;
