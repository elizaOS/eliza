#![allow(non_local_definitions)]
#![allow(unsafe_op_in_unsafe_fn)]

use pyo3::prelude::*;
use pyo3_stub_gen::define_stub_info_gatherer;

mod desktop;
mod element;
mod exceptions;
mod locator;
mod types;

use desktop::Desktop;
use element::UIElement;
use exceptions::*;
use locator::Locator;
use types::*;

#[pymodule]
fn computeruse(_py: Python, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Desktop>()?;
    m.add_class::<UIElement>()?;
    m.add_class::<Locator>()?;
    m.add_class::<ScreenshotResult>()?;
    m.add_class::<Monitor>()?;
    m.add_class::<ClickResult>()?;
    m.add_class::<CommandOutput>()?;
    m.add_class::<UIElementAttributes>()?;
    m.add_class::<UINode>()?;
    m.add_class::<TreeBuildConfig>()?;
    m.add_class::<PropertyLoadingMode>()?;
    m.add_class::<Coordinates>()?;
    m.add_class::<Bounds>()?;
    m.add_class::<ExploreResponse>()?;
    m.add_class::<ExploredElementDetail>()?;
    m.add_class::<TextPosition>()?;
    m.add_class::<FontStyle>()?;
    m.add_class::<HighlightHandle>()?;

    m.add(
        "ElementNotFoundError",
        _py.get_type::<ElementNotFoundError>(),
    )?;
    m.add("TimeoutError", _py.get_type::<TimeoutError>())?;
    m.add(
        "PermissionDeniedError",
        _py.get_type::<PermissionDeniedError>(),
    )?;
    m.add("PlatformError", _py.get_type::<PlatformError>())?;
    m.add(
        "UnsupportedOperationError",
        _py.get_type::<UnsupportedOperationError>(),
    )?;
    m.add(
        "UnsupportedPlatformError",
        _py.get_type::<UnsupportedPlatformError>(),
    )?;
    m.add(
        "InvalidArgumentError",
        _py.get_type::<InvalidArgumentError>(),
    )?;
    m.add("InternalError", _py.get_type::<InternalError>())?;
    Ok(())
}

define_stub_info_gatherer!(stub_info);
