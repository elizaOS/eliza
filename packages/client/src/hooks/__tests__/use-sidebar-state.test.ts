import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useSidebarState } from '../use-sidebar-state';

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

describe('useSidebarState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.getItem.mockReturnValue(null);
  });

  it('should initialize with false when no stored state exists', () => {
    const { result } = renderHook(() => useSidebarState());

    expect(result.current.isVisible).toBe(false);
    expect(localStorageMock.getItem).toHaveBeenCalledWith('eliza-agent-sidebar-visible');
  });

  it('should load stored state when it exists', () => {
    localStorageMock.getItem.mockReturnValue('true');

    const { result } = renderHook(() => useSidebarState());

    expect(result.current.isVisible).toBe(true);
  });

  it('should save state when setSidebarVisible is called', () => {
    const { result } = renderHook(() => useSidebarState());

    act(() => {
      result.current.setSidebarVisible(true);
    });

    expect(result.current.isVisible).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('eliza-agent-sidebar-visible', 'true');
  });

  it('should toggle state when toggleSidebar is called', () => {
    const { result } = renderHook(() => useSidebarState());

    // Initially false
    expect(result.current.isVisible).toBe(false);

    // Toggle to true
    act(() => {
      result.current.toggleSidebar();
    });

    expect(result.current.isVisible).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('eliza-agent-sidebar-visible', 'true');

    // Toggle back to false
    act(() => {
      result.current.toggleSidebar();
    });

    expect(result.current.isVisible).toBe(false);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('eliza-agent-sidebar-visible', 'false');
  });

  it('should handle localStorage errors gracefully', () => {
    localStorageMock.getItem.mockImplementation(() => {
      throw new Error('localStorage error');
    });

    const { result } = renderHook(() => useSidebarState());

    // Should default to false when localStorage fails
    expect(result.current.isVisible).toBe(false);
  });

  it('should handle localStorage save errors gracefully', () => {
    localStorageMock.setItem.mockImplementation(() => {
      throw new Error('localStorage save error');
    });

    const { result } = renderHook(() => useSidebarState());

    // Should still update state even if localStorage fails
    act(() => {
      result.current.setSidebarVisible(true);
    });

    expect(result.current.isVisible).toBe(true);
  });

  it('should handle invalid JSON in localStorage', () => {
    localStorageMock.getItem.mockReturnValue('invalid-json');

    const { result } = renderHook(() => useSidebarState());

    // Should default to false when JSON parsing fails
    expect(result.current.isVisible).toBe(false);
  });
});
