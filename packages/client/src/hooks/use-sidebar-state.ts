import { useState, useEffect, useCallback } from 'react';
import clientLogger from '@/lib/logger';

// Key for storing sidebar visibility state in localStorage
const SIDEBAR_STATE_KEY = 'eliza-agent-sidebar-visible';

/**
 * Custom hook to manage agent sidebar visibility state with localStorage persistence
 * Remembers whether the sidebar should be open or closed across page refreshes
 */
export function useSidebarState() {
  const [isVisible, setIsVisible] = useState<boolean>(false);

  // Load sidebar state from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_STATE_KEY);
      if (stored !== null) {
        const parsedState = JSON.parse(stored);
        setIsVisible(parsedState);
      }
    } catch (error) {
      clientLogger.error('Error reading sidebar state from localStorage:', error);
      // Default to false if there's an error
      setIsVisible(false);
    }
  }, []);

  // Update sidebar state and persist to localStorage
  const setSidebarVisible = useCallback((visible: boolean) => {
    setIsVisible(visible);

    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(visible));
    } catch (error) {
      clientLogger.error('Error saving sidebar state to localStorage:', error);
    }
  }, []);

  // Toggle function for convenience
  const toggleSidebar = useCallback(() => {
    setSidebarVisible(!isVisible);
  }, [isVisible, setSidebarVisible]);

  return {
    isVisible,
    setSidebarVisible,
    toggleSidebar,
  };
}
