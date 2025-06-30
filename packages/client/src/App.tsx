import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
import { createElizaClient } from './lib/api-client-config';
import Chat from './routes/chat';
import AgentCreatorRoute from './routes/createAgent';
import Home from './routes/home';
import NotFound from './routes/not-found';
import GroupChannel from './routes/group';
import { Menu } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from './components/ui/sheet';
import { Button } from './components/ui/button';
import CreateGroupPage from './routes/group-new';
import AgentSettingsRoute from './routes/agent-settings';
import clientLogger from '@/lib/logger';

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
      queryFn: async () => {
        const elizaClient = createElizaClient();
        const result = await elizaClient.agents.listAgents();
        return { data: result };
      },
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [homeKey, setHomeKey] = useState(Date.now());
  const queryClient = useQueryClient();

  useEffect(() => {
    clientLogger.info('[AppContent] Mounted/Updated');
    prefetchInitialData();
  }, []);

  const refreshHomePage = () => {
    clientLogger.info('[AppContent] refreshHomePage called. Current homeKey:', homeKey);
    const newKey = Date.now();
    setHomeKey(newKey);
    clientLogger.info('[AppContent] New homeKey set to:', newKey);

    clientLogger.info('[AppContent] Invalidating queries for Home page refresh.');
    queryClient.invalidateQueries({ queryKey: ['agents'] });
    queryClient.invalidateQueries({ queryKey: ['servers'] });
  };

  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider>
        <AppSidebar refreshHomePage={refreshHomePage} />
        <SidebarInset className="h-screen flex flex-col md:ml-72 overflow-hidden">
          {/* Mobile menu button */}
          <div className="md:hidden absolute top-4 left-4 z-50">
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" data-testid="mobile-menu-button">
                  <Menu className="h-5 w-5" />
                  <span className="sr-only">Toggle menu</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 p-0 z-50">
                <AppSidebar isMobile={true} refreshHomePage={refreshHomePage} />
              </SheetContent>
            </Sheet>
          </div>
          <div className="flex w-full justify-center pt-16 md:pt-0 flex-shrink-0">
            <div className="w-full md:max-w-4xl">
              <ConnectionErrorBanner />
            </div>
          </div>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <Routes>
              <Route path="/" element={<Home key={homeKey} />} />
              <Route
                path="chat/:agentId/:channelId"
                element={
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <Chat />
                  </div>
                }
              />
              <Route
                path="chat/:agentId"
                element={
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <Chat />
                  </div>
                }
              />
              <Route path="settings/:agentId" element={<AgentSettingsRoute />} />
              <Route path="group/new" element={<CreateGroupPage />} />
              <Route path="agents/new" element={<AgentCreatorRoute />} />
              <Route
                path="/create"
                element={
                  <div className="flex w-full justify-center px-4 sm:px-6 overflow-y-auto">
                    <div className="w-full md:max-w-4xl">
                      <AgentCreator />
                    </div>
                  </div>
                }
              />
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
              <Route
                path="group/:channelId"
                element={
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <GroupChannel />
                  </div>
                }
              />
              <Route
                path="settings/"
                element={
                  <div className="flex w-full justify-center overflow-y-auto">
                    <div className="w-full md:max-w-4xl">
                      <EnvSettings />
                    </div>
                  </div>
                }
              />
              {/* Catch-all route for 404 errors */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </div>
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
