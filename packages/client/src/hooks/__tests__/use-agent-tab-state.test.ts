import { renderHook, act, waitFor } from '@testing-library/react';
import { mock, describe, it, expect, beforeEach } from 'bun:test';
import { useAgentTabState } from '../use-agent-tab-state';

// Mock clientLogger
mock.module('../../lib/logger', () => ({
  default: {
    error: mock(),
  },
}));

describe('useAgentTabState', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  it('should initialize with details tab when no agentId is provided', () => {
    const { result } = renderHook(() => useAgentTabState(undefined));

    expect(result.current.currentTab).toBe('details');
  });

  it('should initialize with details tab for new agent', () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440000';
    localStorage.setItem('eliza-agent-tab-states', '{}');

    const { result } = renderHook(() => useAgentTabState(agentId));

    expect(result.current.currentTab).toBe('details');
  });

  it('should load saved tab state for existing agent', async () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440000';
    const savedStates = {
      '550e8400-e29b-41d4-a716-446655440000': 'memories',
    };
    localStorage.setItem('eliza-agent-tab-states', JSON.stringify(savedStates));

    const { result } = renderHook(() => useAgentTabState(agentId));

    await waitFor(() => {
      expect(result.current.currentTab).toBe('memories');
    });
  });

  it('should save tab state when changed', async () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440000';
    localStorage.setItem('eliza-agent-tab-states', '{}');

    const { result } = renderHook(() => useAgentTabState(agentId));

    act(() => {
      result.current.setTab('actions');
    });

    await waitFor(() => {
      expect(result.current.currentTab).toBe('actions');
    });

    expect(localStorage.getItem('eliza-agent-tab-states')).toBe(
      JSON.stringify({ '550e8400-e29b-41d4-a716-446655440000': 'actions' })
    );
  });

  it('should preserve other agent states when updating', () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440001';
    const existingStates = {
      '550e8400-e29b-41d4-a716-446655440000': 'memories',
    };
    localStorage.setItem('eliza-agent-tab-states', JSON.stringify(existingStates));

    const { result } = renderHook(() => useAgentTabState(agentId));

    act(() => {
      result.current.setTab('logs');
    });

    expect(localStorage.getItem('eliza-agent-tab-states')).toBe(
      JSON.stringify({
        '550e8400-e29b-41d4-a716-446655440000': 'memories',
        '550e8400-e29b-41d4-a716-446655440001': 'logs',
      })
    );
  });

  it('should handle localStorage errors gracefully', () => {
    const agentId = '550e8400-e29b-41d4-a716-446655440000';
    const originalGetItem = localStorage.getItem;
    localStorage.getItem = () => {
      throw new Error('localStorage not available');
    };

    const { result } = renderHook(() => useAgentTabState(agentId));

    expect(result.current.currentTab).toBe('details');

    // Restore original getItem
    localStorage.getItem = originalGetItem;
  });

  it('should switch tab state when agentId changes', async () => {
    const savedStates = {
      '550e8400-e29b-41d4-a716-446655440000': 'memories',
      '550e8400-e29b-41d4-a716-446655440001': 'actions',
    };
    localStorage.setItem('eliza-agent-tab-states', JSON.stringify(savedStates));

    const { result, rerender } = renderHook(({ agentId }) => useAgentTabState(agentId), {
      initialProps: { agentId: '550e8400-e29b-41d4-a716-446655440000' as any },
    });

    await waitFor(() => {
      expect(result.current.currentTab).toBe('memories');
    });

    rerender({ agentId: '550e8400-e29b-41d4-a716-446655440001' as any });

    await waitFor(() => {
      expect(result.current.currentTab).toBe('actions');
    });
  });

  it('should not save to localStorage when no agentId is provided', async () => {
    const { result } = renderHook(() => useAgentTabState(undefined));

    act(() => {
      result.current.setTab('actions');
    });

    await waitFor(() => {
      expect(result.current.currentTab).toBe('actions');
    });

    expect(localStorage.getItem('eliza-agent-tab-states')).toBe(null);
  });
});
