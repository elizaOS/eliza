use crate::events::Position;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

/// Information about a DOM element captured from browser
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomElementInfo {
    pub tag_name: String,
    pub id: Option<String>,
    pub class_names: Vec<String>,
    pub attributes: HashMap<String, String>,
    pub css_selector: String,
    pub xpath: String,
    pub inner_text: Option<String>,
    pub input_value: Option<String>,
    pub bounding_rect: DomRect,
    pub is_visible: bool,
    pub is_interactive: bool,
    pub computed_role: Option<String>,
    pub aria_label: Option<String>,
    pub placeholder: Option<String>,
    pub selector_candidates: Vec<SelectorCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub top: f64,
    pub left: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectorCandidate {
    pub selector: String,
    pub selector_type: SelectorType,
    pub specificity: u32,
    pub requires_jquery: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SelectorType {
    Id,
    DataAttribute,
    Class,
    Text,
    AriaLabel,
    XPath,
    CssPath,
}

/// Browser context recorder that coordinates with Chrome extension
#[derive(Clone)]
pub struct BrowserContextRecorder {
    /// Cache of DOM elements by position for quick lookup
    dom_cache: Arc<Mutex<HashMap<(i32, i32), DomElementInfo>>>,

    /// Current recording session ID
    #[allow(dead_code)]
    session_id: Arc<String>,

    /// WebSocket connection status
    extension_connected: Arc<Mutex<bool>>,
}

impl Default for BrowserContextRecorder {
    fn default() -> Self {
        Self {
            dom_cache: Arc::new(Mutex::new(HashMap::new())),
            session_id: Arc::new(uuid::Uuid::new_v4().to_string()),
            extension_connected: Arc::new(Mutex::new(false)),
        }
    }
}

impl BrowserContextRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if Chrome extension is available and connected
    pub async fn is_extension_available(&self) -> bool {
        // Check if we can communicate with the extension via the bridge
        if let Ok(bridge) = computeruse::extension_bridge::try_eval_via_extension(
            "JSON.stringify({connected: true})",
            std::time::Duration::from_secs(1),
        )
        .await
        {
            if bridge.is_some() {
                *self.extension_connected.lock().await = true;
                return true;
            }
        }
        *self.extension_connected.lock().await = false;
        false
    }

    /// Capture DOM element at given screen coordinates
    pub async fn capture_dom_element(&self, position: Position) -> Option<DomElementInfo> {
        // Check cache first
        let cache_key = (position.x, position.y);
        if let Some(cached) = self.dom_cache.lock().await.get(&cache_key) {
            debug!("Using cached DOM element for position {:?}", position);
            return Some(cached.clone());
        }

        // Query Chrome extension for DOM element
        let script = format!(
            r#"
(function() {{
    const screenX = {};
    const screenY = {};

    // Convert screen coordinates to viewport coordinates
    // screenX/screenY are the browser window's position on screen
    // outerHeight - innerHeight gives the browser chrome height (tabs, address bar, etc.)
    const browserChromeHeight = window.outerHeight - window.innerHeight;
    const viewportX = screenX - window.screenX;
    const viewportY = screenY - window.screenY - browserChromeHeight;

    // Check if click is outside web content viewport (browser chrome area: tabs, address bar, etc.)
    // elementFromPoint clips negative coords to 0, returning wrong element - we must reject early
    if (viewportX < 0 || viewportY < 0 || viewportX > window.innerWidth || viewportY > window.innerHeight) {{
        return JSON.stringify({{
            error: 'Click outside viewport (browser chrome)',
            is_browser_chrome: true,
            debug: {{ viewportX, viewportY, innerWidth: window.innerWidth, innerHeight: window.innerHeight }}
        }});
    }}

    // Get element at viewport coordinates
    const element = document.elementFromPoint(viewportX, viewportY);
    if (!element) {{
        return JSON.stringify({{ error: 'No element at coordinates', debug: {{ screenX, screenY, viewportX, viewportY, windowScreenX: window.screenX, windowScreenY: window.screenY, browserChromeHeight }} }});
    }}

    // Helper function to generate XPath (defined at IIFE scope)
    function getXPath(element) {{
        if (element.id) {{
            return `//*[@id="${{element.id}}"]`;
        }}

        const parts = [];
        while (element && element.nodeType === Node.ELEMENT_NODE) {{
            let index = 1;
            let sibling = element.previousElementSibling;
            while (sibling) {{
                if (sibling.tagName === element.tagName) index++;
                sibling = sibling.previousElementSibling;
            }}
            const tagName = element.tagName.toLowerCase();
            const part = tagName + '[' + index + ']';
            parts.unshift(part);
            element = element.parentElement;
        }}
        return '/' + parts.join('/');
    }}

    // Helper function to generate CSS path (defined at IIFE scope)
    function getCSSPath(el) {{
        const path = [];
        while (el && el.nodeType === Node.ELEMENT_NODE) {{
            let selector = el.tagName.toLowerCase();
            if (el.id) {{
                selector = '#' + CSS.escape(el.id);
                path.unshift(selector);
                break;
            }} else if (el.className && typeof el.className === 'string') {{
                const classes = el.className.split(' ').filter(c => c);
                if (classes.length > 0) {{
                    selector += '.' + classes.map(c => CSS.escape(c)).join('.');
                }}
            }}
            path.unshift(selector);
            el = el.parentElement;
        }}
        return path.join(' > ');
    }}

    // Generate selector candidates
    function generateSelectors(el) {{
        const selectors = [];

        // 1. ID selector (highest priority)
        if (el.id) {{
            selectors.push({{
                selector: '#' + CSS.escape(el.id),
                selector_type: 'Id',
                specificity: 100,
                requires_jquery: false
            }});
        }}

        // 2. Data attributes
        const dataAttrs = Array.from(el.attributes)
            .filter(attr => attr.name.startsWith('data-'))
            .map(attr => ({{
                selector: `[${{attr.name}}="${{CSS.escape(attr.value)}}"]`,
                selector_type: 'DataAttribute',
                specificity: 90,
                requires_jquery: false
            }}));
        selectors.push(...dataAttrs);

        // 3. Aria label
        if (el.getAttribute('aria-label')) {{
            selectors.push({{
                selector: `[aria-label="${{CSS.escape(el.getAttribute('aria-label'))}}"]`,
                selector_type: 'AriaLabel',
                specificity: 85,
                requires_jquery: false
            }});
        }}

        // 4. Class combinations
        if (el.className && typeof el.className === 'string') {{
            const classes = el.className.split(' ').filter(c => c);
            if (classes.length > 0) {{
                selectors.push({{
                    selector: '.' + classes.map(c => CSS.escape(c)).join('.'),
                    selector_type: 'Class',
                    specificity: 70,
                    requires_jquery: false
                }});
            }}
        }}

        // 5. Text content for buttons/links
        if (['button', 'a'].includes(el.tagName.toLowerCase())) {{
            const text = el.textContent.trim();
            if (text && text.length < 50) {{
                // Use CSS :contains pseudo-class alternative
                selectors.push({{
                    selector: `${{el.tagName.toLowerCase()}}:contains("${{text}}")`,
                    selector_type: 'Text',
                    specificity: 60,
                    requires_jquery: true
                }});
            }}
        }}

        // 6. XPath selector
        selectors.push({{
            selector: getXPath(el),
            selector_type: 'XPath',
            specificity: 40,
            requires_jquery: false
        }});

        // 7. CSS path (most specific, least maintainable)
        selectors.push({{
            selector: getCSSPath(el),
            selector_type: 'CssPath',
            specificity: 30,
            requires_jquery: false
        }});

        return selectors;
    }}

    // Capture element information
    const rect = element.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(element);

    // Get all attributes as a map
    const attributes = {{}};
    for (const attr of element.attributes) {{
        attributes[attr.name] = attr.value;
    }}

    // Get class names as array
    const classNames = element.className
        ? (typeof element.className === 'string'
            ? element.className.split(' ').filter(c => c)
            : [])
        : [];

    return JSON.stringify({{
        tag_name: element.tagName.toLowerCase(),
        id: element.id || null,
        class_names: classNames,
        attributes: attributes,
        css_selector: getCSSPath(element),
        xpath: getXPath(element),
        inner_text: element.innerText ? element.innerText.substring(0, 100) : null,
        input_value: element.value || null,
        bounding_rect: {{
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left
        }},
        is_visible: computedStyle.display !== 'none' &&
                   computedStyle.visibility !== 'hidden' &&
                   computedStyle.opacity !== '0',
        is_interactive: !element.disabled &&
                       computedStyle.pointerEvents !== 'none',
        computed_role: element.getAttribute('role') || null,
        aria_label: element.getAttribute('aria-label') || null,
        placeholder: element.placeholder || null,
        selector_candidates: generateSelectors(element)
    }});
}})()
"#,
            position.x, position.y
        );

        // Execute script via Chrome extension
        match computeruse::extension_bridge::try_eval_via_extension(
            &script,
            std::time::Duration::from_secs(2),
        )
        .await
        {
            Ok(Some(result)) => {
                // Parse the result
                match serde_json::from_str::<DomElementInfo>(&result) {
                    Ok(dom_info) => {
                        // Cache the result
                        self.dom_cache
                            .lock()
                            .await
                            .insert(cache_key, dom_info.clone());
                        info!(
                            "Captured DOM element: {} with {} selector candidates",
                            dom_info.tag_name,
                            dom_info.selector_candidates.len()
                        );
                        Some(dom_info)
                    }
                    Err(e) => {
                        // Check if it's an error response
                        if let Ok(error_obj) = serde_json::from_str::<serde_json::Value>(&result) {
                            if error_obj
                                .get("is_browser_chrome")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false)
                            {
                                info!("[DOM] Click on browser chrome (tabs/address bar) - skipping DOM capture, will use UIA");
                            } else if let Some(error) = error_obj.get("error") {
                                warn!("DOM capture error: {}", error);
                            }
                        } else {
                            error!("Failed to parse DOM element info: {}", e);
                        }
                        None
                    }
                }
            }
            Ok(None) => {
                warn!("Chrome extension not available for DOM capture");
                None
            }
            Err(e) => {
                error!("Failed to communicate with Chrome extension: {}", e);
                None
            }
        }
    }

    /// Clear the DOM cache (useful when navigating to a new page)
    pub async fn clear_cache(&self) {
        self.dom_cache.lock().await.clear();
        debug!("Cleared DOM element cache");
    }

    /// Get current page context (URL, title, etc.)
    pub async fn get_page_context(&self) -> Option<PageContext> {
        let script = r#"
JSON.stringify({
    url: window.location.href,
    title: document.title,
    domain: window.location.hostname,
    path: window.location.pathname,
    has_focus: document.hasFocus(),
    ready_state: document.readyState,
    form_count: document.forms.length,
    link_count: document.links.length
})
"#;

        match computeruse::extension_bridge::try_eval_via_extension(
            script,
            std::time::Duration::from_secs(1),
        )
        .await
        {
            Ok(Some(result)) => match serde_json::from_str::<PageContext>(&result) {
                Ok(context) => Some(context),
                Err(e) => {
                    error!("Failed to parse page context: {}", e);
                    None
                }
            },
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageContext {
    pub url: String,
    pub title: String,
    pub domain: String,
    pub path: String,
    pub has_focus: bool,
    pub ready_state: String,
    pub form_count: usize,
    pub link_count: usize,
}
