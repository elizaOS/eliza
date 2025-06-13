import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePanelWidthState } from '../use-panel-width-state';

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// Mock clientLogger
vi.mock('@/lib/logger', () => ({
  default: {
    error: vi.fn(),
  },
}));

describe('usePanelWidthState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.getItem.mockReturnValue(null);
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

  it('should load persisted values from localStorage on mount', () => {
    localStorageMock.getItem
      .mockReturnValueOnce('65') // main panel size
      .mockReturnValueOnce('35'); // sidebar panel size

    const { result } = renderHook(() => usePanelWidthState());

    expect(result.current.mainPanelSize).toBe(65);
    expect(result.current.sidebarPanelSize).toBe(35);
  });

  it('should persist main panel size to localStorage when updated', () => {
    const { result } = renderHook(() => usePanelWidthState());

    act(() => {
      result.current.setMainPanelSize(75);
    });

    expect(result.current.mainPanelSize).toBe(75);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('eliza-main-panel-width', '75');
  });

  it('should persist sidebar panel size to localStorage when updated', () => {
    const { result } = renderHook(() => usePanelWidthState());

    act(() => {
      result.current.setSidebarPanelSize(25);
    });

    expect(result.current.sidebarPanelSize).toBe(25);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('eliza-sidebar-panel-width', '25');
  });

  it('should validate and clamp panel sizes within bounds', () => {
    const { result } = renderHook(() => usePanelWidthState());

    // Test main panel size clamping
    act(() => {
      result.current.setMainPanelSize(5); // Below minimum (20)
    });
    expect(result.current.mainPanelSize).toBe(20);

    act(() => {
      result.current.setMainPanelSize(90); // Above maximum (80)
    });
    expect(result.current.mainPanelSize).toBe(80);

    // Test sidebar panel size clamping
    act(() => {
      result.current.setSidebarPanelSize(15); // Below minimum (20)
    });
    expect(result.current.sidebarPanelSize).toBe(20);

    act(() => {
      result.current.setSidebarPanelSize(85); // Above maximum (80)
    });
    expect(result.current.sidebarPanelSize).toBe(80);
  });

  it('should reset panel sizes to defaults and clear localStorage', () => {
    localStorageMock.getItem.mockReturnValueOnce('60').mockReturnValueOnce('40');

    const { result } = renderHook(() => usePanelWidthState());

    // Verify initial persisted values
    expect(result.current.mainPanelSize).toBe(60);
    expect(result.current.sidebarPanelSize).toBe(40);

    act(() => {
      result.current.resetPanelSizes();
    });

    expect(result.current.mainPanelSize).toBe(70);
    expect(result.current.sidebarPanelSize).toBe(30);
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('eliza-main-panel-width');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('eliza-sidebar-panel-width');
  });

  it('should handle localStorage errors gracefully when reading', () => {
    localStorageMock.getItem.mockImplementation(() => {
      throw new Error('localStorage error');
    });

    const { result } = renderHook(() => usePanelWidthState());

    // Should fall back to defaults
    expect(result.current.mainPanelSize).toBe(70);
    expect(result.current.sidebarPanelSize).toBe(30);
  });

  it('should handle localStorage errors gracefully when writing', () => {
    localStorageMock.setItem.mockImplementation(() => {
      throw new Error('localStorage error');
    });

    const { result } = renderHook(() => usePanelWidthState());

    // Should still update state even if localStorage fails
    act(() => {
      result.current.setMainPanelSize(65);
    });

    expect(result.current.mainPanelSize).toBe(65);
  });

  it('should handle invalid JSON values from localStorage', () => {
    localStorageMock.getItem
      .mockReturnValueOnce('invalid-number')
      .mockReturnValueOnce('also-invalid');

    const { result } = renderHook(() => usePanelWidthState());

    // Should fall back to defaults for invalid values
    expect(result.current.mainPanelSize).toBe(70);
    expect(result.current.sidebarPanelSize).toBe(30);
  });

  it('should handle out-of-range values from localStorage', () => {
    localStorageMock.getItem
      .mockReturnValueOnce('150') // Above 100
      .mockReturnValueOnce('0'); // Below 1

    const { result } = renderHook(() => usePanelWidthState());

    // Should fall back to defaults for out-of-range values
    expect(result.current.mainPanelSize).toBe(70);
    expect(result.current.sidebarPanelSize).toBe(30);
  });

  it('should detect floating mode based on window width', () => {
    // Set narrow width (below 1400 threshold)
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

    // Initially not floating (window width is 1200)
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
    expect(localStorageMock.setItem).toHaveBeenCalledWith('eliza-floating-threshold', '900');
  });

  it('should respond to window resize events', () => {
    const { result } = renderHook(() => usePanelWidthState());

    // Initially not floating (window width is 1200 from beforeEach, above 1400 threshold)
    expect(result.current.isFloatingMode).toBe(false);

    // Simulate window resize to narrow width (below 1400 threshold)
    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 1300,
      });
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current.isFloatingMode).toBe(true);

    // Simulate window resize back to wide width (above 1400 threshold)
    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 1500,
      });
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current.isFloatingMode).toBe(false);
  });
});
