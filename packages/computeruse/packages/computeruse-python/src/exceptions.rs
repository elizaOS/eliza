use pyo3_stub_gen::create_exception;

// Custom Python exceptions for advanced error mapping
create_exception!(
    computeruse,
    ElementNotFoundError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(computeruse, TimeoutError, pyo3::exceptions::PyRuntimeError);
create_exception!(
    computeruse,
    PermissionDeniedError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(computeruse, PlatformError, pyo3::exceptions::PyRuntimeError);
create_exception!(
    computeruse,
    UnsupportedOperationError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(
    computeruse,
    UnsupportedPlatformError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(
    computeruse,
    InvalidArgumentError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(computeruse, InternalError, pyo3::exceptions::PyRuntimeError);
create_exception!(
    computeruse,
    InvalidSelectorError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(
    computeruse,
    ElementDetachedError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(
    computeruse,
    ElementNotVisibleError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(
    computeruse,
    ElementNotEnabledError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(
    computeruse,
    ElementNotStableError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(
    computeruse,
    ElementObscuredError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(
    computeruse,
    ScrollFailedError,
    pyo3::exceptions::PyRuntimeError
);
create_exception!(
    computeruse,
    OperationCancelledError,
    pyo3::exceptions::PyRuntimeError
);

use ::computeruse_core::errors::AutomationError;

// Advanced error mapping
pub fn automation_error_to_pyerr(e: AutomationError) -> pyo3::PyErr {
    let msg = format!("{e}");
    match e {
        AutomationError::ElementNotFound(_) => ElementNotFoundError::new_err(msg),
        AutomationError::Timeout(_) => TimeoutError::new_err(msg),
        AutomationError::PermissionDenied(_) => PermissionDeniedError::new_err(msg),
        AutomationError::PlatformError(_) => PlatformError::new_err(msg),
        AutomationError::UnsupportedOperation(_) => UnsupportedOperationError::new_err(msg),
        AutomationError::UnsupportedPlatform(_) => UnsupportedPlatformError::new_err(msg),
        AutomationError::InvalidArgument(_) => InvalidArgumentError::new_err(msg),
        AutomationError::Internal(_) => InternalError::new_err(msg),
        AutomationError::InvalidSelector(_) => InvalidSelectorError::new_err(msg),
        AutomationError::UIAutomationAPIError { .. } => PlatformError::new_err(msg),
        AutomationError::ElementDetached(_) => ElementDetachedError::new_err(msg),
        AutomationError::ElementNotVisible(_) => ElementNotVisibleError::new_err(msg),
        AutomationError::ElementNotEnabled(_) => ElementNotEnabledError::new_err(msg),
        AutomationError::ElementNotStable(_) => ElementNotStableError::new_err(msg),
        AutomationError::ElementObscured(_) => ElementObscuredError::new_err(msg),
        AutomationError::ScrollFailed(_) => ScrollFailedError::new_err(msg),
        AutomationError::OperationCancelled(_) => OperationCancelledError::new_err(msg),
        AutomationError::VerificationFailed(_) => InternalError::new_err(msg),
    }
}
