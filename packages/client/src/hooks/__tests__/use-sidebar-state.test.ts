import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'bun:test';
import { useSidebarState } from '../use-sidebar-state';

describe('useSidebarState', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  it('should initialize with false when no stored state exists', () => {
    const { result } = renderHook(() => useSidebarState());

    expect(result.current.isVisible).toBe(false);
  });

  it('should load stored state when it exists', async () => {
    localStorage.setItem('eliza-agent-sidebar-visible', 'true');

    const { result } = renderHook(() => useSidebarState());

    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });
  });

  it('should save state when setSidebarVisible is called', async () => {
    const { result } = renderHook(() => useSidebarState());

    act(() => {
      result.current.setSidebarVisible(true);
    });

    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });

    expect(localStorage.getItem('eliza-agent-sidebar-visible')).toBe('true');
  });

  it('should toggle state when toggleSidebar is called', async () => {
    const { result } = renderHook(() => useSidebarState());

    // Initially false
    expect(result.current.isVisible).toBe(false);

    // Toggle to true
    act(() => {
      result.current.toggleSidebar();
    });

    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });

    expect(localStorage.getItem('eliza-agent-sidebar-visible')).toBe('true');

    // Toggle back to false
    act(() => {
      result.current.toggleSidebar();
    });

    await waitFor(() => {
      expect(result.current.isVisible).toBe(false);
    });

    expect(localStorage.getItem('eliza-agent-sidebar-visible')).toBe('false');
  });

  it('should handle localStorage errors gracefully', () => {
    // Set up invalid JSON
    localStorage.setItem('eliza-agent-sidebar-visible', 'invalid-json');

    const { result } = renderHook(() => useSidebarState());

    // Should default to false when JSON parsing fails
    expect(result.current.isVisible).toBe(false);
  });

  it('should handle localStorage save errors gracefully', async () => {
    // Mock localStorage to throw an error on setItem
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('localStorage save error');
    };

    const { result } = renderHook(() => useSidebarState());

    // Should still update state even if localStorage fails
    act(() => {
      result.current.setSidebarVisible(true);
    });

    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });

    // Restore original setItem
    localStorage.setItem = originalSetItem;
  });

  it('should handle invalid JSON in localStorage', () => {
    localStorage.setItem('eliza-agent-sidebar-visible', 'invalid-json');

    const { result } = renderHook(() => useSidebarState());

    // Should default to false when JSON parsing fails
    expect(result.current.isVisible).toBe(false);
  });
});
