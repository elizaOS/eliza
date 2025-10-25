import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useAgentRuns, useAgentRunDetail } from './runs';
import { createMockElizaClient, createTestQueryClient, createWrapper } from '../__tests__/test-utils';

describe('run hooks', () => {
    let client: ReturnType<typeof createMockElizaClient>;

    beforeEach(() => {
        client = createMockElizaClient({
            runs: {
                listRuns: mock(async () => ({ runs: [{ id: 'run-1' }], total: 1, hasMore: false })),
                getRun: mock(async () => ({ id: 'run-1', status: 'complete' })),
            },
        });
    });

    it('fetches agent runs with params', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const params = { limit: 10, status: 'complete' } as const;
        const { result } = renderHook(() => useAgentRuns('agent-1', params), { wrapper });

        await act(async () => {
            await result.current.refetch();
        });

        expect(client.runs.listRuns).toHaveBeenCalledWith('agent-1', params);
        expect(result.current.data).toEqual({ runs: [{ id: 'run-1' }], total: 1, hasMore: false });
    });

    it('does not fetch runs when agent id missing', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgentRuns(null), { wrapper });

        await act(async () => {
            await result.current.refetch();
        });

        expect(client.runs.listRuns).not.toHaveBeenCalled();
        expect(result.current.data).toBeUndefined();
    });

    it('fetches run detail when identifiers present', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgentRunDetail('agent-1', 'run-1', 'room-1'), { wrapper });

        await act(async () => {
            await result.current.refetch();
        });

        expect(client.runs.getRun).toHaveBeenCalledWith('agent-1', 'run-1', 'room-1');
        expect(result.current.data).toEqual({ id: 'run-1', status: 'complete' });
    });

    it('skips run detail when missing identifiers', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgentRunDetail('agent-1', null), { wrapper });

        await act(async () => {
            await result.current.refetch();
        });

        expect(client.runs.getRun).not.toHaveBeenCalled();
        expect(result.current.data).toBeUndefined();
    });
});



