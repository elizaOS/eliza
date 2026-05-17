import type { ReactNode } from "react";
export interface ApiEndpointCardPricing {
    cost?: number;
    unit?: string;
    isFree?: boolean;
    isVariable?: boolean;
    estimatedRange?: {
        min: number;
        max: number;
    };
}
export interface ApiEndpointCardEndpoint {
    name: string;
    description: string;
    method: string;
    path: string;
    category: string;
    tags: string[];
    deprecated?: boolean;
    pricing?: ApiEndpointCardPricing;
}
export interface EndpointCardProps<TEndpoint extends ApiEndpointCardEndpoint = ApiEndpointCardEndpoint> {
    endpoint: TEndpoint;
    onSelect: (endpoint: TEndpoint) => void;
    getMethodColor: (method: string) => string;
    getCategoryIcon: (category: string) => ReactNode;
    formatPricing?: (pricing: NonNullable<TEndpoint["pricing"]>) => string;
}
export declare function EndpointCard<TEndpoint extends ApiEndpointCardEndpoint = ApiEndpointCardEndpoint>({ endpoint, onSelect, getMethodColor, getCategoryIcon, formatPricing, }: EndpointCardProps<TEndpoint>): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=endpoint-card.d.ts.map