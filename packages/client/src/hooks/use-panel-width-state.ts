import { useState, useEffect, useCallback } from 'react';
import clientLogger from '@/lib/logger';

// Keys for storing panel width state in localStorage
const MAIN_PANEL_WIDTH_KEY = 'eliza-main-panel-width';
const SIDEBAR_PANEL_WIDTH_KEY = 'eliza-sidebar-panel-width';

// Default panel sizes
const DEFAULT_MAIN_PANEL_SIZE = 70;
const DEFAULT_SIDEBAR_PANEL_SIZE = 30;

/**
 * Custom hook to manage panel width state with localStorage persistence
 * Remembers panel sizes across page refreshes
 */
export function usePanelWidthState() {
  const [mainPanelSize, setMainPanelSize] = useState<number>(DEFAULT_MAIN_PANEL_SIZE);
  const [sidebarPanelSize, setSidebarPanelSize] = useState<number>(DEFAULT_SIDEBAR_PANEL_SIZE);

  // Load panel sizes from localStorage on mount
  useEffect(() => {
    try {
      const storedMainSize = localStorage.getItem(MAIN_PANEL_WIDTH_KEY);
      const storedSidebarSize = localStorage.getItem(SIDEBAR_PANEL_WIDTH_KEY);
      
      if (storedMainSize !== null) {
        const parsedMainSize = parseFloat(storedMainSize);
        if (!isNaN(parsedMainSize) && parsedMainSize > 0 && parsedMainSize <= 100) {
          setMainPanelSize(parsedMainSize);
        }
      }
      
      if (storedSidebarSize !== null) {
        const parsedSidebarSize = parseFloat(storedSidebarSize);
        if (!isNaN(parsedSidebarSize) && parsedSidebarSize > 0 && parsedSidebarSize <= 100) {
          setSidebarPanelSize(parsedSidebarSize);
        }
      }
    } catch (error) {
      clientLogger.error('Error reading panel sizes from localStorage:', error);
      // Use defaults if there's an error
      setMainPanelSize(DEFAULT_MAIN_PANEL_SIZE);
      setSidebarPanelSize(DEFAULT_SIDEBAR_PANEL_SIZE);
    }
  }, []);

  // Update main panel size and persist to localStorage
  const setMainPanelSizePersistent = useCallback((size: number) => {
    // Validate size is within reasonable bounds
    const validatedSize = Math.max(20, Math.min(80, size));
    setMainPanelSize(validatedSize);
    
    try {
      localStorage.setItem(MAIN_PANEL_WIDTH_KEY, validatedSize.toString());
    } catch (error) {
      clientLogger.error('Error saving main panel size to localStorage:', error);
    }
  }, []);

  // Update sidebar panel size and persist to localStorage
  const setSidebarPanelSizePersistent = useCallback((size: number) => {
    // Validate size is within reasonable bounds
    const validatedSize = Math.max(20, Math.min(80, size));
    setSidebarPanelSize(validatedSize);
    
    try {
      localStorage.setItem(SIDEBAR_PANEL_WIDTH_KEY, validatedSize.toString());
    } catch (error) {
      clientLogger.error('Error saving sidebar panel size to localStorage:', error);
    }
  }, []);

  // Reset to default sizes
  const resetPanelSizes = useCallback(() => {
    setMainPanelSize(DEFAULT_MAIN_PANEL_SIZE);
    setSidebarPanelSize(DEFAULT_SIDEBAR_PANEL_SIZE);
    
    try {
      localStorage.removeItem(MAIN_PANEL_WIDTH_KEY);
      localStorage.removeItem(SIDEBAR_PANEL_WIDTH_KEY);
    } catch (error) {
      clientLogger.error('Error clearing panel sizes from localStorage:', error);
    }
  }, []);

  return {
    mainPanelSize,
    sidebarPanelSize,
    setMainPanelSize: setMainPanelSizePersistent,
    setSidebarPanelSize: setSidebarPanelSizePersistent,
    resetPanelSizes,
  };
} 