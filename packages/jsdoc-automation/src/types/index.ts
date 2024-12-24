export interface ASTQueueItem {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    nodeType: string;
    code: string;
    className?: string;
    methodName?: string;
    jsDoc?: string;
}

export interface Repository {
    owner: string;
    name: string;
    pullNumber?: number;
}

export interface FullModeFileChange {
    filename: string;
    status: string;
}

export interface PrModeFileChange extends FullModeFileChange {
    additions: number;
    deletions: number;
    changes: number;
    contents_url: string;
}