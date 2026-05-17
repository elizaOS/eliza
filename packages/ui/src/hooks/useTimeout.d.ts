export declare function useTimeout(): {
    setTimeout: (callback: () => void, ms: number) => NodeJS.Timeout;
    clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};
//# sourceMappingURL=useTimeout.d.ts.map