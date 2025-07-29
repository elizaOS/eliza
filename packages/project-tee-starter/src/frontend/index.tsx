import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import './index.css';
import React from 'react';
import type { UUID } from '@elizaos/core';

const queryClient = new QueryClient();

// Define the interface for the ELIZA_CONFIG
interface ElizaConfig {
    agentId: string;
    apiBase: string;
}

// Declare global window extension for TypeScript
declare global {
    interface Window {
        ELIZA_CONFIG?: ElizaConfig;
    }
}

/**
 * Main TEE Status route component
 */
function TEEStatusRoute() {
    const config = window.ELIZA_CONFIG;
    const agentId = config?.agentId;

    // Apply dark mode to the root element
    React.useEffect(() => {
        document.documentElement.classList.add('dark');
    }, []);

    if (!agentId) {
        return (
            <div className="p-4 text-center">
                <div className="text-red-600 font-medium">Error: Agent ID not found</div>
                <div className="text-sm text-gray-600 mt-2">
                    The server should inject the agent ID configuration.
                </div>
            </div>
        );
    }

    return <TEEProvider agentId={agentId as UUID} />;
}

/**
 * TEE Status provider component
 */
function TEEProvider({ agentId }: { agentId: UUID }) {
    return (
        <QueryClientProvider client={queryClient}>
            <div className="min-h-screen bg-background">
                <TEEStatusPanel agentId={agentId} />
            </div>
        </QueryClientProvider>
    );
}

// Initialize the application - no router needed for iframe
const rootElement = document.getElementById('root');
if (rootElement) {
    createRoot(rootElement).render(<TEEStatusRoute />);
}

// Define types for integration with agent UI system
export interface AgentPanel {
    name: string;
    path: string;
    component: React.ComponentType<any>;
    icon?: string;
    public?: boolean;
    shortLabel?: string; // Optional short label for mobile
}

interface PanelProps {
    agentId: string;
}

/**
 * TEE Status panel component that shows TEE connection status and information
 */
const TEEStatusPanel: React.FC<PanelProps> = ({ agentId }) => {
    const [teeStatus, setTeeStatus] = React.useState<{
        connected: boolean;
        mode?: string;
        vendor?: string;
        error?: string;
    }>({ connected: false });

    React.useEffect(() => {
        // Fetch TEE status from the backend
        fetch(`/mr-tee-status`)
            .then(res => res.json())
            .then(data => {
                setTeeStatus({
                    connected: true,
                    mode: data.tee_mode,
                    vendor: data.tee_vendor,
                });
            })
            .catch(err => {
                setTeeStatus({
                    connected: false,
                    error: err.message,
                });
            });
    }, []);

    return (
        <div className="p-6">
            <div className="max-w-4xl mx-auto">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-foreground mb-2">Mr. TEE Status</h1>
                    <p className="text-muted-foreground">
                        Agent ID: <code className="text-sm bg-muted px-2 py-1 rounded">{agentId}</code>
                    </p>
                </div>

                <div className="grid gap-6 md:grid-cols-2">
                    {/* Connection Status Card */}
                    <div className="bg-card rounded-lg p-6 border border-border">
                        <h2 className="text-xl font-semibold mb-4">TEE Connection</h2>
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Status</span>
                                <span className={`tee-status-badge ${teeStatus.connected ? 'connected' : 'disconnected'}`}>
                                    {teeStatus.connected ? 'Connected' : 'Disconnected'}
                                </span>
                            </div>
                            {teeStatus.mode && (
                                <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">Mode</span>
                                    <span className="text-foreground">{teeStatus.mode}</span>
                                </div>
                            )}
                            {teeStatus.vendor && (
                                <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">Vendor</span>
                                    <span className="text-foreground">{teeStatus.vendor}</span>
                                </div>
                            )}
                            {teeStatus.error && (
                                <div className="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded">
                                    <p className="text-sm text-destructive">{teeStatus.error}</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* TEE Information Card */}
                    <div className="bg-card rounded-lg p-6 border border-border">
                        <h2 className="text-xl font-semibold mb-4">TEE Information</h2>
                        <div className="space-y-3">
                            <div>
                                <h3 className="text-sm font-medium text-muted-foreground mb-1">About TEE</h3>
                                <p className="text-sm">
                                    Trusted Execution Environment provides hardware-based security for sensitive operations,
                                    including key derivation and cryptographic signing.
                                </p>
                            </div>
                            <div>
                                <h3 className="text-sm font-medium text-muted-foreground mb-1">Features</h3>
                                <ul className="text-sm space-y-1">
                                    <li>• Secure key derivation</li>
                                    <li>• Hardware-isolated execution</li>
                                    <li>• Remote attestation support</li>
                                    <li>• Protected memory regions</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    {/* Agent Portrait */}
                    <div className="md:col-span-2 bg-card rounded-lg p-6 border border-border">
                        <h2 className="text-xl font-semibold mb-4">Agent Portrait</h2>
                        <div className="flex justify-center">
                            <img
                                src="/assets/mr-tee-portrait.jpg"
                                alt="Mr. TEE"
                                className="w-48 h-48 rounded-full border-4 border-primary"
                            />
                        </div>
                        <p className="text-center mt-4 text-muted-foreground">
                            Mr. TEE - Your Trusted Execution Environment Agent
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

// Export the panel configuration for integration with the agent UI
export const panels: AgentPanel[] = [
    {
        name: 'TEE Status',
        path: 'tee-status',
        component: TEEStatusPanel,
        icon: 'Shield',
        public: false,
        shortLabel: 'TEE',
    },
];

export * from './utils'; 