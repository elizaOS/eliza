declare module "@/app/api/mcp/registry/route" {
  export interface McpRegistryEntry {
    id: string;
    name: string;
    description: string;
    category: string;
    endpoint: string;
    type: "streamable-http" | "stdio";
    version: string;
    status: "live" | "coming_soon" | "maintenance";
    icon: string;
    color: string;
    toolCount: number;
    features: string[];
    pricing: {
      type: "free" | "credits" | "x402";
      description: string;
      pricePerRequest?: string;
    };
    x402Enabled: boolean;
    documentation?: string;
    configTemplate: {
      servers: Record<
        string,
        {
          type: "streamable-http" | "stdio";
          url: string;
        }
      >;
    };
  }
}

declare module "@/app/api/crypto/status/route" {
  export interface CryptoStatusResponse {
    enabled: boolean;
    supportedTokens: string[];
    networks: Array<{ id: string; name: string }>;
    isTestnet: boolean;
  }
}

