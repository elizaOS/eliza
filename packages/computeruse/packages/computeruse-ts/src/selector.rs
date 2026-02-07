use napi::bindgen_prelude::FromNapiValue;
use napi_derive::napi;
use std::collections::BTreeMap;
use computeruse::selector::Selector as ComputerUseSelector;

/// Selector for locating UI elements. Provides a typed alternative to the string based selector API.
#[napi(js_name = "Selector")]
pub struct Selector {
    pub(crate) inner: ComputerUseSelector,
}

impl std::fmt::Display for Selector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.inner)
    }
}

impl From<ComputerUseSelector> for Selector {
    fn from(sel: ComputerUseSelector) -> Self {
        Selector { inner: sel }
    }
}

impl From<&Selector> for ComputerUseSelector {
    fn from(sel: &Selector) -> Self {
        sel.inner.clone()
    }
}

impl FromNapiValue for Selector {
    unsafe fn from_napi_value(
        env: napi::sys::napi_env,
        napi_val: napi::sys::napi_value,
    ) -> napi::Result<Self> {
        let mut result = std::ptr::null_mut();
        let status = napi::sys::napi_get_value_external(env, napi_val, &mut result);
        if status != napi::sys::Status::napi_ok {
            return Err(napi::Error::new(
                napi::Status::InvalidArg,
                "Failed to get external value for Selector".to_string(),
            ));
        }
        Ok(std::ptr::read(result as *const Selector))
    }
}

#[napi]
impl Selector {
    /// Create a selector that matches elements by their accessibility `name`.
    #[napi(factory)]
    pub fn name(name: String) -> Self {
        Selector::from(ComputerUseSelector::Name(name))
    }

    /// Create a selector that matches elements by role (and optionally name).
    #[napi(factory)]
    pub fn role(role: String, name: Option<String>) -> Self {
        Selector::from(ComputerUseSelector::Role { role, name })
    }

    /// Create a selector that matches elements by accessibility `id`.
    #[napi(factory, js_name = "id")]
    pub fn id_factory(id: String) -> Self {
        Selector::from(ComputerUseSelector::Id(id))
    }

    /// Create a selector that matches elements by the text they display.
    #[napi(factory)]
    pub fn text(text: String) -> Self {
        Selector::from(ComputerUseSelector::Text(text))
    }

    /// Create a selector from an XPath-like path string.
    #[napi(factory)]
    pub fn path(path: String) -> Self {
        Selector::from(ComputerUseSelector::Path(path))
    }

    /// Create a selector that matches elements by a native automation id (e.g., AutomationID on Windows).
    #[napi(factory, js_name = "nativeId")]
    pub fn native_id(id: String) -> Self {
        Selector::from(ComputerUseSelector::NativeId(id))
    }

    /// Create a selector that matches elements by their class name.
    #[napi(factory, js_name = "className")]
    pub fn class_name(name: String) -> Self {
        Selector::from(ComputerUseSelector::ClassName(name))
    }

    /// Create a selector from an arbitrary attribute map.
    #[napi(factory)]
    pub fn attributes(attributes: std::collections::HashMap<String, String>) -> Self {
        let map: BTreeMap<String, String> = attributes.into_iter().collect();
        Selector::from(ComputerUseSelector::Attributes(map))
    }

    /// Chain another selector onto this selector.
    #[napi]
    pub fn chain(&self, other: &Selector) -> Selector {
        Selector::from(ComputerUseSelector::Chain(vec![
            self.inner.clone(),
            other.inner.clone(),
        ]))
    }

    /// Filter by visibility.
    #[napi]
    pub fn visible(&self, is_visible: bool) -> Selector {
        Selector::from(ComputerUseSelector::Chain(vec![
            self.inner.clone(),
            ComputerUseSelector::Visible(is_visible),
        ]))
    }

    /// Create a selector that selects the nth element from matches.
    /// Positive values are 0-based from the start (0 = first, 1 = second).
    /// Negative values are from the end (-1 = last, -2 = second-to-last).
    #[napi(factory)]
    pub fn nth(index: i32) -> Self {
        Selector::from(ComputerUseSelector::Nth(index))
    }

    /// Create a selector that matches elements having at least one descendant matching the inner selector.
    /// This is similar to Playwright's :has() pseudo-class.
    #[napi(factory)]
    pub fn has(inner_selector: &Selector) -> Self {
        Selector::from(ComputerUseSelector::Has(Box::new(
            inner_selector.inner.clone(),
        )))
    }

    /// Create a selector that navigates to the parent element.
    /// This is similar to Playwright's .. syntax.
    #[napi(factory)]
    pub fn parent() -> Self {
        Selector::from(ComputerUseSelector::Parent)
    }

    /// Create a selector that scopes the search to a specific process.
    /// This is typically used as the first part of a chained selector.
    /// Example: `Selector.process("chrome").chain(Selector.role("Button", "Submit"))`
    #[napi(factory)]
    pub fn process(process_name: String) -> Self {
        Selector::from(ComputerUseSelector::Process(process_name))
    }

    /// Create a selector that scopes the search to a specific window within a process.
    /// Typically chained after a process selector.
    /// Example: `Selector.process("notepad").chain(Selector.window("Untitled"))`
    #[napi(factory)]
    pub fn window(title: String) -> Self {
        Selector::from(ComputerUseSelector::Role {
            role: "Window".to_string(),
            name: Some(title),
        })
    }
}
