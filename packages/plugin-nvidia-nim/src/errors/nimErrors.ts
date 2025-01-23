export enum ErrorSeverity {
    LOW = "LOW",
    MEDIUM = "MEDIUM",
    HIGH = "HIGH"
}

export enum NimErrorCode {
    VALIDATION_FAILED = "VALIDATION_FAILED",
    API_ERROR = "API_ERROR",
    NETWORK_ERROR = "NETWORK_ERROR",
    PARSE_ERROR = "PARSE_ERROR",
    FILE_NOT_FOUND = "FILE_NOT_FOUND",
    DOWNLOAD_ERROR = "DOWNLOAD_ERROR",
    FILE_OPERATION_FAILED = "FILE_OPERATION_FAILED"
}

export class NimError extends Error {
    code: NimErrorCode;
    severity: ErrorSeverity;
    details?: unknown;

    constructor(code: NimErrorCode, message: string, severity: ErrorSeverity, details?: unknown) {
        super(message);
        this.code = code;
        this.severity = severity;
        this.details = details;
        this.name = "NimError";
    }
}
