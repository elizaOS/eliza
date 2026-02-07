use crate::element::UIElement;
use crate::exceptions::automation_error_to_pyerr;
use ::computeruse_core::locator::Locator as ComputerUseLocator;
use pyo3::prelude::*;
use pyo3_async_runtimes::tokio as pyo3_tokio;
use pyo3_async_runtimes::TaskLocals;
use pyo3_stub_gen::derive::*;

/// Locator for finding UI elements by selector.
#[gen_stub_pyclass]
#[pyclass(name = "Locator")]
pub struct Locator {
    pub inner: ComputerUseLocator,
}

#[gen_stub_pymethods]
#[pymethods]
impl Locator {
    #[pyo3(name = "first", text_signature = "($self)")]
    /// (async) Get the first matching element.
    ///
    /// Returns:
    ///     UIElement: The first matching element.
    pub fn first<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let locator = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let element = locator
                .first(None)
                .await
                .map_err(automation_error_to_pyerr)?;
            Ok(UIElement { inner: element })
        })
    }

    #[pyo3(name = "all", signature = (timeout_ms=None, depth=None))]
    #[pyo3(text_signature = "($self, timeout_ms, depth)")]
    /// (async) Get all matching elements.
    ///
    /// Args:
    ///     timeout_ms (Optional[int]): Timeout in milliseconds.
    ///     depth (Optional[int]): Maximum depth to search.
    ///
    /// Returns:
    ///     List[UIElement]: List of matching elements.
    pub fn all<'py>(
        &self,
        py: Python<'py>,
        timeout_ms: Option<u64>,
        depth: Option<usize>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let locator = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let elements = locator
                .all(timeout_ms.map(std::time::Duration::from_millis), depth)
                .await
                .map_err(automation_error_to_pyerr)?;
            Ok(elements
                .into_iter()
                .map(|e| UIElement { inner: e })
                .collect::<Vec<_>>())
        })
    }

    #[pyo3(name = "wait", signature = (timeout_ms=None))]
    #[pyo3(text_signature = "($self, timeout_ms)")]
    /// (async) Wait for the first matching element.
    ///
    /// Args:
    ///     timeout_ms (Optional[int]): Timeout in milliseconds.
    ///
    /// Returns:
    ///     UIElement: The first matching element.
    pub fn wait<'py>(
        &self,
        py: Python<'py>,
        timeout_ms: Option<u64>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let locator = self.inner.clone();
        pyo3_tokio::future_into_py_with_locals(py, TaskLocals::with_running_loop(py)?, async move {
            let element = locator
                .wait(timeout_ms.map(std::time::Duration::from_millis))
                .await
                .map_err(automation_error_to_pyerr)?;
            Ok(UIElement { inner: element })
        })
    }

    #[pyo3(name = "timeout", text_signature = "($self, timeout_ms)")]
    /// Set a default timeout for this locator.
    ///
    /// Args:
    ///     timeout_ms (int): Timeout in milliseconds.
    ///
    /// Returns:
    ///     Locator: A new locator with the specified timeout.
    pub fn timeout(&self, timeout_ms: u64) -> Locator {
        Locator {
            inner: self
                .inner
                .clone()
                .set_default_timeout(std::time::Duration::from_millis(timeout_ms)),
        }
    }

    #[pyo3(name = "locator", text_signature = "($self, selector)")]
    /// Chain another selector.
    ///
    /// Args:
    ///     selector (str): The selector string.
    ///
    /// Returns:
    ///     Locator: A new locator with the chained selector.
    pub fn locator(&self, selector: &str) -> PyResult<Locator> {
        let locator = self.inner.locator(selector);
        Ok(Locator { inner: locator })
    }

    #[pyo3(name = "within", text_signature = "($self, element)")]
    /// Set the root element for this locator.
    ///
    /// Args:
    ///     element (UIElement): The root element.
    ///
    /// Returns:
    ///     Locator: A new locator with the specified root element.
    pub fn within(&self, element: &UIElement) -> Locator {
        Locator {
            inner: self.inner.clone().within(element.inner.clone()),
        }
    }
}
