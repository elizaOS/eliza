import { type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useServerConfig } from '@/context/ServerConfigContext';
import clientLogger from '@/lib/logger';

interface ProtectedRouteProps {
  children: ReactNode;
}

/**
 * ProtectedRoute - HOC to protect routes that require authentication
 *
 * This component checks if the server requires authentication and if the user is authenticated.
 * If authentication is required but the user is not authenticated, it:
 * 1. Opens the authentication dialog
 * 2. Redirects the user to the home page
 *
 * Usage:
 * ```tsx
 * <ProtectedRoute>
 *   <YourProtectedComponent />
 * </ProtectedRoute>
 * ```
 */
export const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { requiresAuth, isLoading: isLoadingServerConfig } = useServerConfig();
  const { isAuthenticated, requireAuth } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // Wait for server config to load before making navigation decisions
    if (isLoadingServerConfig) {
      return;
    }

    // If server requires auth and user is not authenticated, redirect
    if (requiresAuth && !isAuthenticated) {
      clientLogger.info('[ProtectedRoute] Auth required but not authenticated - redirecting to home');
      requireAuth(); // Open auth dialog
      navigate('/'); // Redirect to home
    }
  }, [requiresAuth, isAuthenticated, isLoadingServerConfig, navigate, requireAuth]);

  // Show nothing while loading config (prevents flash of content)
  if (isLoadingServerConfig) {
    return null;
  }

  // Show nothing while checking auth (prevents flash of content)
  if (requiresAuth && !isAuthenticated) {
    return null;
  }

  // User is authenticated or auth is not required - render children
  return <>{children}</>;
};
