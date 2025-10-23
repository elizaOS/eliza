import React, { createContext, useContext, useMemo } from 'react';
import { ElizaClient } from '@elizaos/api-client';
import type { ApiClientConfig } from '@elizaos/api-client';

interface ElizaReactContextValue {
    client: ElizaClient;
}

const ElizaReactContext = createContext<ElizaReactContextValue | null>(null);

interface ElizaReactProviderProps {
    children: React.ReactNode;
    client?: ElizaClient;
    baseUrl?: string;
    apiKey?: string;
    timeout?: number;
    headers?: Record<string, string>;
}

/**
 * Provider component that supplies an ElizaClient instance to all hooks.
 * 
 * Can be initialized with either:
 * - A pre-configured `client` instance
 * - Configuration options (`baseUrl`, `apiKey`, etc.) to construct a new client
 * 
 * @example
 * ```tsx
 * // With pre-configured client
 * const client = new ElizaClient({ baseUrl: 'http://localhost:3000' });
 * <ElizaReactProvider client={client}>
 *   <App />
 * </ElizaReactProvider>
 * 
 * // With configuration
 * <ElizaReactProvider baseUrl="http://localhost:3000" apiKey="secret">
 *   <App />
 * </ElizaReactProvider>
 * ```
 */
export function ElizaReactProvider({
    children,
    client: providedClient,
    baseUrl,
    apiKey,
    timeout,
    headers,
}: ElizaReactProviderProps) {
    const client = useMemo(() => {
        if (providedClient) {
            return providedClient;
        }

        if (!baseUrl) {
            throw new Error(
                'ElizaReactProvider requires either a `client` prop or a `baseUrl` prop'
            );
        }

        const config: ApiClientConfig = {
            baseUrl,
            apiKey,
            timeout,
            headers,
        };

        return new ElizaClient(config);
    }, [providedClient, baseUrl, apiKey, timeout, headers]);

    const value = useMemo<ElizaReactContextValue>(
        () => ({
            client,
        }),
        [client]
    );

    return (
        <ElizaReactContext.Provider value={value}>
            {children}
        </ElizaReactContext.Provider>
    );
}

/**
 * Hook to access the ElizaClient instance from context.
 * Must be used within an ElizaReactProvider.
 * 
 * @throws Error if used outside of ElizaReactProvider
 */
export function useElizaClient(): ElizaClient {
    const context = useContext(ElizaReactContext);

    if (!context) {
        throw new Error(
            'useElizaClient must be used within an ElizaReactProvider'
        );
    }

    return context.client;
}

