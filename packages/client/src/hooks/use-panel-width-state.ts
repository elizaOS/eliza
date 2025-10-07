import { useState, useEffect, useCallback } from 'react';
import clientLogger from '@/lib/logger';

// Keys for storing panel width state in localStorage
const MAIN_PANEL_WIDTH_KEY = 'eliza-main-panel-width';
const SIDEBAR_PANEL_WIDTH_KEY = 'eliza-sidebar-panel-width';
const FLOATING_THRESHOLD_KEY = 'eliza-floating-threshold';

// Default panel sizes
const DEFAULT_MAIN_PANEL_SIZE = 70;
const DEFAULT_SIDEBAR_PANEL_SIZE = 30;
const DEFAULT_FLOATING_THRESHOLD = 1400; // Switch to floating mode below this width

/**
 * Custom hook to manage panel width state with localStorage persistence
 * Includes resize detection for automatic floating mode switching
 */
export function usePanelWidthState() {
  const [mainPanelSize, setMainPanelSize] = useState<number>(DEFAULT_MAIN_PANEL_SIZE);
  const [sidebarPanelSize, setSidebarPanelSize] = useState<number>(DEFAULT_SIDEBAR_PANEL_SIZE);
  const [isFloatingMode, setIsFloatingMode] = useState<boolean>(false);
  const [floatingThreshold, setFloatingThreshold] = useState<number>(DEFAULT_FLOATING_THRESHOLD);

  // Load panel sizes from localStorage on mount
  useEffect(() => {
    try {
      const storedMainSize = localStorage.getItem(MAIN_PANEL_WIDTH_KEY);
      const storedSidebarSize = localStorage.getItem(SIDEBAR_PANEL_WIDTH_KEY);
      const storedThreshold = localStorage.getItem(FLOATING_THRESHOLD_KEY);

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

      if (storedThreshold !== null) {
        const parsedThreshold = parseFloat(storedThreshold);
        if (!isNaN(parsedThreshold) && parsedThreshold > 0) {
          setFloatingThreshold(parsedThreshold);
        }
      }
    } catch (error) {
      clientLogger.error('Error reading panel sizes from localStorage:', error);
      // Use defaults if there's an error
      setMainPanelSize(DEFAULT_MAIN_PANEL_SIZE);
      setSidebarPanelSize(DEFAULT_SIDEBAR_PANEL_SIZE);
      setFloatingThreshold(DEFAULT_FLOATING_THRESHOLD);
    }
  }, []);

  // Resize listener to detect when to switch to floating mode
  useEffect(() => {
    const checkFloatingMode = () => {
      const shouldFloat = window.innerWidth < floatingThreshold;
      setIsFloatingMode(shouldFloat);
    };

    // Check on mount
    checkFloatingMode();

    // Add resize listener
    window.addEventListener('resize', checkFloatingMode);

    return () => {
      window.removeEventListener('resize', checkFloatingMode);
    };
  }, [floatingThreshold]);

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

  // Update floating threshold and persist to localStorage
  const setFloatingThresholdPersistent = useCallback((threshold: number) => {
    const validatedThreshold = Math.max(320, Math.min(2560, threshold));
    setFloatingThreshold(validatedThreshold);

    try {
      localStorage.setItem(FLOATING_THRESHOLD_KEY, validatedThreshold.toString());
    } catch (error) {
      clientLogger.error('Error saving floating threshold to localStorage:', error);
    }
  }, []);

  // Manual toggle for floating mode (overrides automatic detection)
  const toggleFloatingMode = useCallback(() => {
    setIsFloatingMode((prev) => !prev);
  }, []);

  // Reset to default sizes
  const resetPanelSizes = useCallback(() => {
    setMainPanelSize(DEFAULT_MAIN_PANEL_SIZE);
    setSidebarPanelSize(DEFAULT_SIDEBAR_PANEL_SIZE);
    setFloatingThreshold(DEFAULT_FLOATING_THRESHOLD);

    try {
      localStorage.removeItem(MAIN_PANEL_WIDTH_KEY);
      localStorage.removeItem(SIDEBAR_PANEL_WIDTH_KEY);
      localStorage.removeItem(FLOATING_THRESHOLD_KEY);
    } catch (error) {
      clientLogger.error('Error clearing panel sizes from localStorage:', error);
    }
  }, []);

  return {
    mainPanelSize,
    sidebarPanelSize,
    isFloatingMode,
    floatingThreshold,
    setMainPanelSize: setMainPanelSizePersistent,
    setSidebarPanelSize: setSidebarPanelSizePersistent,
    setFloatingThreshold: setFloatingThresholdPersistent,
    toggleFloatingMode,
    resetPanelSizes,
  };
}
