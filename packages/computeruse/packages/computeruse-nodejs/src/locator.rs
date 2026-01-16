use napi_derive::napi;
use computeruse::locator::WaitCondition as ComputerUseWaitCondition;
use computeruse::Locator as ComputerUseLocator;

use crate::map_error;
use crate::Element;
use crate::Selector;
use napi::bindgen_prelude::Either;

/// Locator for finding UI elements by selector.
#[napi(js_name = "Locator")]
pub struct Locator {
    inner: ComputerUseLocator,
}

impl std::fmt::Display for Locator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Locator({})", self.inner.selector_string())
    }
}

impl From<ComputerUseLocator> for Locator {
    fn from(l: ComputerUseLocator) -> Self {
        Locator { inner: l }
    }
}

#[napi]
impl Locator {
    /// (async) Get the first matching element.
    ///
    /// @param {number} [timeoutMs] - Timeout in milliseconds (default: 10000).
    /// @returns {Promise<Element>} The first matching element.
    #[napi]
    pub async fn first(&self, timeout_ms: Option<f64>) -> napi::Result<Element> {
        use std::time::Duration;
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(10000.0) as u64);
        self.inner
            .first(Some(timeout))
            .await
            .map(Element::from)
            .map_err(map_error)
    }

    /// (async) Get all matching elements.
    ///
    /// @param {number} timeoutMs - Timeout in milliseconds (required).
    /// @param {number} [depth] - Maximum depth to search.
    /// @returns {Promise<Array<Element>>} List of matching elements.
    #[napi]
    pub async fn all(&self, timeout_ms: f64, depth: Option<u32>) -> napi::Result<Vec<Element>> {
        use std::time::Duration;
        let timeout = Duration::from_millis(timeout_ms as u64);
        let depth = depth.map(|d| d as usize);
        self.inner
            .all(Some(timeout), depth)
            .await
            .map(|els| els.into_iter().map(Element::from).collect())
            .map_err(map_error)
    }

    /// Set a default timeout for this locator.
    ///
    /// @param {number} timeoutMs - Timeout in milliseconds.
    /// @returns {Locator} A new locator with the specified timeout.
    #[napi]
    pub fn timeout(&self, timeout_ms: f64) -> Locator {
        let loc = self
            .inner
            .clone()
            .set_default_timeout(std::time::Duration::from_millis(timeout_ms as u64));
        Locator::from(loc)
    }

    /// Set the root element for this locator.
    ///
    /// @param {Element} element - The root element.
    /// @returns {Locator} A new locator with the specified root element.
    #[napi]
    pub fn within(&self, element: &Element) -> Locator {
        let loc = self.inner.clone().within(element.inner.clone());
        Locator::from(loc)
    }

    /// Chain another selector.
    /// Accepts either a selector string or a Selector object.
    ///
    /// @param {string | Selector} selector - The selector.
    /// @returns {Locator} A new locator with the chained selector.
    #[napi]
    pub fn locator(
        &self,
        #[napi(ts_arg_type = "string | Selector")] selector: Either<String, &Selector>,
    ) -> napi::Result<Locator> {
        use napi::bindgen_prelude::Either::*;
        let sel_rust: computeruse::selector::Selector = match selector {
            A(sel_str) => sel_str.as_str().into(),
            B(sel_obj) => sel_obj.inner.clone(),
        };
        let loc = self.inner.clone().locator(sel_rust);
        Ok(Locator::from(loc))
    }

    /// (async) Validate element existence without throwing an error.
    ///
    /// @param {number} timeoutMs - Timeout in milliseconds (required).
    /// @returns {Promise<ValidationResult>} Validation result with exists flag and optional element.
    #[napi]
    pub async fn validate(&self, timeout_ms: f64) -> napi::Result<ValidationResult> {
        use std::time::Duration;
        let timeout = Duration::from_millis(timeout_ms as u64);
        match self.inner.validate(Some(timeout)).await {
            Ok(Some(element)) => Ok(ValidationResult {
                exists: true,
                element: Some(Element::from(element)),
                error: None,
            }),
            Ok(None) => Ok(ValidationResult {
                exists: false,
                element: None,
                error: None,
            }),
            Err(e) => Ok(ValidationResult {
                exists: false,
                element: None,
                error: Some(e.to_string()),
            }),
        }
    }

    /// (async) Wait for an element to meet a specific condition.
    ///
    /// @param {string} condition - Condition to wait for: 'exists', 'visible', 'enabled', 'focused'
    /// @param {number} timeoutMs - Timeout in milliseconds (required).
    /// @returns {Promise<Element>} The element when condition is met.
    #[napi]
    pub async fn wait_for(&self, condition: String, timeout_ms: f64) -> napi::Result<Element> {
        use std::time::Duration;
        let wait_condition = parse_condition(&condition)?;
        let timeout = Duration::from_millis(timeout_ms as u64);

        self.inner
            .wait_for(wait_condition, Some(timeout))
            .await
            .map(Element::from)
            .map_err(map_error)
    }
}

/// Result of element validation
#[napi(object)]
pub struct ValidationResult {
    /// Whether the element exists
    pub exists: bool,
    /// The element if found
    pub element: Option<Element>,
    /// Error message if validation failed (not element not found, but actual error)
    pub error: Option<String>,
}
/// Convert string condition to WaitCondition enum
fn parse_condition(condition: &str) -> napi::Result<ComputerUseWaitCondition> {
    match condition.to_lowercase().as_str() {
        "exists" => Ok(ComputerUseWaitCondition::Exists),
        "visible" => Ok(ComputerUseWaitCondition::Visible),
        "enabled" => Ok(ComputerUseWaitCondition::Enabled),
        "focused" => Ok(ComputerUseWaitCondition::Focused),
        _ => Err(napi::Error::new(
            napi::Status::InvalidArg,
            format!("Invalid condition '{condition}'. Valid: exists, visible, enabled, focused"),
        )),
    }
}
