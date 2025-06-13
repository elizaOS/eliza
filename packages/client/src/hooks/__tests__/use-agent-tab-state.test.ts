import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useAgentTabState } from '../use-agent-tab-state';

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

describe('useAgentTabState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.getItem.mockReturnValue(null);
  });

  it('should initialize with details tab when no agentId is provided', () => {
    const { result } = renderHook(() => useAgentTabState(undefined));

    expect(result.current.currentTab).toBe('details');
  });

  it('should initialize with details tab for new agent', () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440000';
    localStorageMock.getItem.mockReturnValue('{}');

    const { result } = renderHook(() => useAgentTabState(agentId));

    expect(result.current.currentTab).toBe('details');
    expect(localStorageMock.getItem).toHaveBeenCalledWith('eliza-agent-tab-states');
  });

  it('should load saved tab state for existing agent', () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440000';
    const savedStates = {
      '550e8400-e29b-41d4-a716-446655440000': 'memories',
    };
    localStorageMock.getItem.mockReturnValue(JSON.stringify(savedStates));

    const { result } = renderHook(() => useAgentTabState(agentId));

    expect(result.current.currentTab).toBe('memories');
  });

  it('should save tab state when changed', () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440000';
    localStorageMock.getItem.mockReturnValue('{}');

    const { result } = renderHook(() => useAgentTabState(agentId));

    act(() => {
      result.current.setTab('actions');
    });

    expect(result.current.currentTab).toBe('actions');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'eliza-agent-tab-states',
      JSON.stringify({ '550e8400-e29b-41d4-a716-446655440000': 'actions' })
    );
  });

  it('should preserve other agent states when updating', () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440001';
    const existingStates = {
      '550e8400-e29b-41d4-a716-446655440000': 'memories',
    };
    localStorageMock.getItem.mockReturnValue(JSON.stringify(existingStates));

    const { result } = renderHook(() => useAgentTabState(agentId));

    act(() => {
      result.current.setTab('logs');
    });

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'eliza-agent-tab-states',
      JSON.stringify({
        '550e8400-e29b-41d4-a716-446655440000': 'memories',
        '550e8400-e29b-41d4-a716-446655440001': 'logs',
      })
    );
  });

  it('should handle localStorage errors gracefully', () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440000';
    localStorageMock.getItem.mockImplementation(() => {
      throw new Error('localStorage not available');
    });

    const { result } = renderHook(() => useAgentTabState(agentId));

    expect(result.current.currentTab).toBe('details');
  });

  it('should switch tab state when agentId changes', () => {
    const savedStates = {
      '550e8400-e29b-41d4-a716-446655440000': 'memories',
      '550e8400-e29b-41d4-a716-446655440001': 'actions',
    };
    localStorageMock.getItem.mockReturnValue(JSON.stringify(savedStates));

    const { result, rerender } = renderHook(({ agentId }) => useAgentTabState(agentId), {
      initialProps: { agentId: '550e8400-e29b-41d4-a716-446655440000' as any },
    });

    expect(result.current.currentTab).toBe('memories');

    rerender({ agentId: '550e8400-e29b-41d4-a716-446655440001' as any });

    expect(result.current.currentTab).toBe('actions');
  });

  it('should not save to localStorage when no agentId is provided', () => {
    const { result } = renderHook(() => useAgentTabState(undefined));

    act(() => {
      result.current.setTab('actions');
    });

    expect(result.current.currentTab).toBe('actions');
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });
});
