export interface LocalDownloadProgress {
    ratio: number;
    meta: string;
    ready: boolean;
}
export interface StateLocalDownloadProps {
    transcript?: string;
    progress?: LocalDownloadProgress;
    onUseCloudInstead: () => void;
    onContinue: () => void;
    onReady?: () => void;
}
export declare function StateLocalDownload(props: StateLocalDownloadProps): React.JSX.Element;
//# sourceMappingURL=StateLocalDownload.d.ts.map