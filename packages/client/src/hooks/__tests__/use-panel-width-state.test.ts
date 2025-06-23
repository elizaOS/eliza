import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'bun:test';
import { usePanelWidthState } from '../use-panel-width-state';

describe('usePanelWidthState', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();

    // Reset window dimensions (above 1400 threshold)
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1500,
    });
  });

  it('should initialize with default values when localStorage is empty', () => {
    const { result } = renderHook(() => usePanelWidthState());

    expect(result.current.mainPanelSize).toBe(70);
    expect(result.current.sidebarPanelSize).toBe(30);
    expect(result.current.isFloatingMode).toBe(false);
    expect(result.current.floatingThreshold).toBe(1400);
  });

  it('should load persisted values from localStorage on mount', async () => {
    // Set up localStorage with saved values (use correct keys)
    localStorage.setItem('eliza-main-panel-width', '65');
    localStorage.setItem('eliza-sidebar-panel-width', '35');

    const { result } = renderHook(() => usePanelWidthState());

    await waitFor(() => {
      expect(result.current.mainPanelSize).toBe(65);
      expect(result.current.sidebarPanelSize).toBe(35);
    });
  });

  it('should persist main panel size to localStorage when updated', async () => {
    const { result } = renderHook(() => usePanelWidthState());

    act(() => {
      result.current.setMainPanelSize(75);
    });

    await waitFor(() => {
      expect(result.current.mainPanelSize).toBe(75);
    });

    expect(localStorage.getItem('eliza-main-panel-width')).toBe('75');
  });

  it('should persist sidebar panel size to localStorage when updated', async () => {
    const { result } = renderHook(() => usePanelWidthState());

    act(() => {
      result.current.setSidebarPanelSize(25);
    });

    await waitFor(() => {
      expect(result.current.sidebarPanelSize).toBe(25);
    });

    expect(localStorage.getItem('eliza-sidebar-panel-width')).toBe('25');
  });

  it('should validate and clamp panel sizes within bounds', async () => {
    const { result } = renderHook(() => usePanelWidthState());

    // Test main panel size clamping
    act(() => {
      result.current.setMainPanelSize(5); // Below minimum (20)
    });

    await waitFor(() => {
      expect(result.current.mainPanelSize).toBe(20);
    });

    act(() => {
      result.current.setMainPanelSize(95); // Above maximum (80)
    });

    await waitFor(() => {
      expect(result.current.mainPanelSize).toBe(80);
    });

    // Test sidebar panel size clamping
    act(() => {
      result.current.setSidebarPanelSize(15); // Below minimum (20)
    });

    await waitFor(() => {
      expect(result.current.sidebarPanelSize).toBe(20);
    });

    act(() => {
      result.current.setSidebarPanelSize(85); // Above maximum (80)
    });

    await waitFor(() => {
      expect(result.current.sidebarPanelSize).toBe(80);
    });
  });

  it('should reset panel sizes to defaults and clear localStorage', () => {
    // Set up some custom values first
    localStorage.setItem('eliza-main-panel-width', '60');
    localStorage.setItem('eliza-sidebar-panel-width', '40');

    const { result } = renderHook(() => usePanelWidthState());

    // Verify initial persisted values
    expect(result.current.mainPanelSize).toBe(60);
    expect(result.current.sidebarPanelSize).toBe(40);

    // Reset to defaults
    act(() => {
      result.current.resetPanelSizes();
    });

    expect(result.current.mainPanelSize).toBe(70);
    expect(result.current.sidebarPanelSize).toBe(30);
    expect(localStorage.getItem('eliza-main-panel-width')).toBe(null);
    expect(localStorage.getItem('eliza-sidebar-panel-width')).toBe(null);
  });

  it('should handle localStorage errors gracefully when reading', () => {
    // Set up invalid values
    localStorage.setItem('eliza-main-panel-width', 'invalid');
    localStorage.setItem('eliza-sidebar-panel-width', 'invalid');

    const { result } = renderHook(() => usePanelWidthState());

    // Should fall back to defaults
    expect(result.current.mainPanelSize).toBe(70);
    expect(result.current.sidebarPanelSize).toBe(30);
  });

  it('should handle localStorage errors gracefully when writing', () => {
    const { result } = renderHook(() => usePanelWidthState());

    // Mock localStorage to throw an error on setItem
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('localStorage save error');
    };

    // Should still update state even if localStorage fails
    act(() => {
      result.current.setMainPanelSize(65);
    });

    expect(result.current.mainPanelSize).toBe(65);

    // Restore original setItem immediately
    localStorage.setItem = originalSetItem;
  });

  it('should handle invalid JSON values from localStorage', () => {
    localStorage.setItem('eliza-main-panel-width', 'not-a-number');
    localStorage.setItem('eliza-sidebar-panel-width', 'also-not-a-number');

    const { result } = renderHook(() => usePanelWidthState());

    // Should use defaults when values can't be parsed
    expect(result.current.mainPanelSize).toBe(70);
    expect(result.current.sidebarPanelSize).toBe(30);
  });

  it('should handle out-of-range values from localStorage', () => {
    localStorage.setItem('eliza-main-panel-width', '150'); // Way too high (> 100)
    localStorage.setItem('eliza-sidebar-panel-width', '0'); // Way too low (<= 0)

    const { result } = renderHook(() => usePanelWidthState());

    // Should fall back to defaults when values are out of valid loading range
    expect(result.current.mainPanelSize).toBe(70); // Default value
    expect(result.current.sidebarPanelSize).toBe(30); // Default value
  });

  it('should detect floating mode based on window width', () => {
    // Set window width below threshold
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1300,
    });

    const { result } = renderHook(() => usePanelWidthState());

    expect(result.current.isFloatingMode).toBe(true);
  });

  it('should toggle floating mode manually', () => {
    const { result } = renderHook(() => usePanelWidthState());

    expect(result.current.isFloatingMode).toBe(false);

    act(() => {
      result.current.toggleFloatingMode();
    });

    expect(result.current.isFloatingMode).toBe(true);
  });

  it('should update floating threshold and persist to localStorage', () => {
    const { result } = renderHook(() => usePanelWidthState());

    act(() => {
      result.current.setFloatingThreshold(900);
    });

    expect(result.current.floatingThreshold).toBe(900);
    expect(localStorage.getItem('eliza-floating-threshold')).toBe('900');
  });

  it('should respond to window resize events', () => {
    const { result } = renderHook(() => usePanelWidthState());

    // Initially not in floating mode (width 1500 > 1400)
    expect(result.current.isFloatingMode).toBe(false);

    act(() => {
      // Simulate window resize to trigger floating mode
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 1300,
      });
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current.isFloatingMode).toBe(true);
  });
});
