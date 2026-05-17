import { type ReactNode } from "react";
type NavigateOptions = {
    scroll?: boolean;
};
type ClientRouter = {
    push: (href: string, options?: NavigateOptions) => void;
    replace: (href: string, options?: NavigateOptions) => void;
    refresh: () => void;
    back: () => void;
    forward: () => void;
    prefetch: (_href: string) => Promise<void>;
};
export declare function useRouter(): ClientRouter;
export declare function usePathname(): string;
export declare function useSearchParams(): URLSearchParams;
export declare function notFound(): never;
export declare function redirect(href: string): never;
export declare function useSelectedLayoutSegment(): string | null;
export declare function useSelectedLayoutSegments(): string[];
export declare function useParams<T extends Record<string, string | string[]> = Record<string, string>>(): T;
export declare function useServerInsertedHTML(_callback: () => ReactNode): void;
export declare function useCallbackRouterPush(href: string, options?: NavigateOptions): () => void;
export {};
//# sourceMappingURL=navigation.d.ts.map