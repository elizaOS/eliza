import "./index.css";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { AppSidebar } from "./components/app-sidebar";
import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { STALE_TIMES } from "./hooks/use-query-hooks";
import useVersion from "./hooks/use-version";
import { apiClient } from "./lib/api";
import Chat from "./routes/chat";
import AgentCreatorRoute from "./routes/createAgent";
import Home from "./routes/home";
import Settings from "./routes/settings";

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
      queryKey: ["agents"],
      queryFn: () => apiClient.getAgents(),
      staleTime: STALE_TIMES.FREQUENT,
    });
  } catch (error) {
    console.error("Error prefetching initial data:", error);
    // Don't throw, let the app continue loading with fallbacks
  }
};

// Execute prefetch immediately
prefetchInitialData();

export default function App() {
  useVersion();

  // Also prefetch when the component mounts (helps with HMR and refreshes)
  useEffect(() => {
    prefetchInitialData();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <div
        className="dark antialiased"
        style={{
          colorScheme: "dark",
        }}
      >
        <TooltipProvider delayDuration={0}>
          <SidebarProvider>
            <div className="flex h-screen w-screen overflow-hidden">
              <AppSidebar />
              <SidebarInset>
                <main className="flex-1 overflow-hidden">
                  <Outlet />
                </main>
              </SidebarInset>
            </div>
            <Toaster />
          </SidebarProvider>
        </TooltipProvider>
      </div>
    </QueryClientProvider>
  );
}
