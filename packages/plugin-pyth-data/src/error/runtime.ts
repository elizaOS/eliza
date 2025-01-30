import { PythError, ErrorSeverity, PythErrorCode, type ErrorDetails } from './base';

export class RuntimeError extends PythError {
    public readonly name: string = 'RuntimeError';

    constructor(
        code: PythErrorCode,
        message: string,
        severity: ErrorSeverity = ErrorSeverity.HIGH,
        details?: ErrorDetails,
        originalError?: Error
    ) {
        super(code, message, severity, details, originalError);
        Object.setPrototypeOf(this, new.target.prototype);
    }

    // Factory methods
    static initializationError(component: string, reason: string, error?: Error): RuntimeError {
        return new RuntimeError(
            PythErrorCode.RUNTIME_INITIALIZATION,
            `Failed to initialize ${component}: ${reason}`,
            ErrorSeverity.HIGH,
            { component, reason },
            error
        );
    }

    static configurationError(component: string, reason: string, error?: Error): RuntimeError {
        return new RuntimeError(
            PythErrorCode.RUNTIME_CONFIGURATION,
            `Configuration error in ${component}: ${reason}`,
            ErrorSeverity.HIGH,
            { component, reason },
            error
        );
    }

    static validationError(component: string, reason: string, error?: Error): RuntimeError {
        return new RuntimeError(
            PythErrorCode.RUNTIME_VALIDATION,
            `Validation error in ${component}: ${reason}`,
            ErrorSeverity.HIGH,
            { component, reason },
            error
        );
    }

    static stateTransitionError(
        component: string,
        fromState: string,
        toState: string,
        reason: string
    ): RuntimeError {
        return new RuntimeError(
            PythErrorCode.STATE_INVALID_TRANSITION,
            `Invalid state transition in ${component} from ${fromState} to ${toState}: ${reason}`,
            ErrorSeverity.HIGH,
            { component, fromState, toState, reason }
        );
    }

    static statePersistenceError(component: string, operation: string, error?: Error): RuntimeError {
        return new RuntimeError(
            PythErrorCode.STATE_PERSISTENCE,
            `Failed to ${operation} state for ${component}`,
            ErrorSeverity.HIGH,
            { component, operation },
            error
        );
    }
} 