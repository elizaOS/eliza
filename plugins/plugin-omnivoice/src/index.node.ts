/**
 * Node entry point. omnivoice.cpp requires a native shared library so
 * this is functionally identical to the default export.
 */
import omnivoicePlugin from "./index";

export * from "./index";
export default omnivoicePlugin;
