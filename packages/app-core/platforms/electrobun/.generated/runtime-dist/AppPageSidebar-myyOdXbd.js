import { D as require_jsx_runtime } from "./electrobun-runtime-zXJ9acDW.js";
import { Sidebar } from "@elizaos/ui";
import { PanelLeftClose } from "lucide-react";
import * as React$1 from "react";
import { useCallback, useMemo, useState } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/shared/AppPageSidebar.js
var import_jsx_runtime = require_jsx_runtime();
const DEFAULT_PAGE_SIDEBAR_WIDTH = 240;
const DEFAULT_PAGE_SIDEBAR_MIN_WIDTH = 200;
const DEFAULT_PAGE_SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_SYNC_STORAGE_PREFIX = "elizaos:ui:sidebar:";
const PAGE_SIDEBAR_WIDTH_STORAGE_PREFIX = "eliza:page-sidebar:";
const PAGE_SIDEBAR_ROOT_CLASS = "!mt-0 !h-full !bg-none !bg-transparent !rounded-none !border-0 !border-r !border-r-border/30 !shadow-none !backdrop-blur-none !ring-0";
const PAGE_SIDEBAR_FOOTER_CLASS = "!justify-stretch !px-2 !pt-1.5 !pb-2";
const PAGE_SIDEBAR_COLLAPSE_BUTTON_CLASS = "!border-0 !bg-transparent !shadow-none hover:!bg-transparent hover:!text-txt";
function joinClassNames(...values) {
	const className = values.filter(Boolean).join(" ").trim();
	return className.length > 0 ? className : void 0;
}
function clampSidebarWidth(value, minWidth, maxWidth) {
	return Math.min(Math.max(value, minWidth), maxWidth);
}
function buildPageSidebarWidthStorageKey(identity) {
	return `${PAGE_SIDEBAR_WIDTH_STORAGE_PREFIX}${identity}:width`;
}
function buildSidebarCollapsedStorageKey(syncId) {
	return `${SIDEBAR_SYNC_STORAGE_PREFIX}${syncId}:collapsed`;
}
function readStoredSidebarWidth(storageKey, defaultWidth, minWidth, maxWidth) {
	if (!storageKey || typeof window === "undefined") return clampSidebarWidth(defaultWidth, minWidth, maxWidth);
	try {
		const raw = window.localStorage.getItem(storageKey);
		const parsed = raw ? Number.parseInt(raw, 10) : NaN;
		if (Number.isFinite(parsed)) return clampSidebarWidth(parsed, minWidth, maxWidth);
	} catch {}
	return clampSidebarWidth(defaultWidth, minWidth, maxWidth);
}
function persistSidebarWidth(storageKey, width) {
	if (!storageKey || typeof window === "undefined") return;
	try {
		window.localStorage.setItem(storageKey, String(width));
	} catch {}
}
function readStoredSidebarCollapsed(syncId, fallbackValue) {
	if (!syncId || typeof window === "undefined") return fallbackValue;
	try {
		const raw = window.localStorage.getItem(buildSidebarCollapsedStorageKey(syncId));
		return raw == null ? fallbackValue : raw === "true";
	} catch {
		return fallbackValue;
	}
}
const AppPageSidebar = React$1.forwardRef(function AppPageSidebar({ bottomAction, className, collapseButtonAriaLabel = "Collapse sidebar", collapseButtonClassName, collapsible = false, collapsed: collapsedProp, contentIdentity, defaultCollapsed = false, defaultWidth = DEFAULT_PAGE_SIDEBAR_WIDTH, expandButtonAriaLabel = "Expand sidebar", footer, footerClassName, header, headerClassName, maxWidth = DEFAULT_PAGE_SIDEBAR_MAX_WIDTH, minWidth = DEFAULT_PAGE_SIDEBAR_MIN_WIDTH, onCollapseRequest, onCollapsedChange, onWidthChange, resizable, showExpandedCollapseButton = false, syncId, testId, variant = "default", width: widthProp, widthStorageKey, ...props }, ref) {
	const desktopDefaultVariant = variant === "default";
	const effectiveResizable = resizable ?? desktopDefaultVariant;
	const resolvedSyncId = syncId ?? (desktopDefaultVariant && collapsible ? `eliza:page-sidebar:${contentIdentity ?? testId ?? "default"}` : void 0);
	const [internalCollapsed, setInternalCollapsed] = useState(() => readStoredSidebarCollapsed(resolvedSyncId, defaultCollapsed));
	const controlledCollapsed = collapsedProp !== void 0;
	const collapsed = controlledCollapsed ? collapsedProp : internalCollapsed;
	const handleCollapsedChange = useCallback((next) => {
		if (!controlledCollapsed) setInternalCollapsed(next);
		onCollapsedChange?.(next);
	}, [controlledCollapsed, onCollapsedChange]);
	const resolvedWidthStorageKey = useMemo(() => {
		if (widthStorageKey) return widthStorageKey;
		if (!desktopDefaultVariant || !effectiveResizable || !contentIdentity) return null;
		return buildPageSidebarWidthStorageKey(contentIdentity);
	}, [
		contentIdentity,
		desktopDefaultVariant,
		effectiveResizable,
		widthStorageKey
	]);
	const [internalWidth, setInternalWidth] = useState(() => readStoredSidebarWidth(resolvedWidthStorageKey, defaultWidth, minWidth, maxWidth));
	const controlledWidth = widthProp !== void 0;
	const width = controlledWidth ? widthProp : internalWidth;
	const handleWidthChange = useCallback((next) => {
		const clamped = clampSidebarWidth(next, minWidth, maxWidth);
		if (!controlledWidth) {
			setInternalWidth(clamped);
			persistSidebarWidth(resolvedWidthStorageKey, clamped);
		}
		onWidthChange?.(clamped);
	}, [
		controlledWidth,
		maxWidth,
		minWidth,
		onWidthChange,
		resolvedWidthStorageKey
	]);
	const defaultFooter = footer ?? (desktopDefaultVariant && (collapsible || bottomAction) ? (0, import_jsx_runtime.jsxs)("div", {
		className: joinClassNames("flex w-full items-center gap-2", collapsible ? "justify-between" : "justify-end"),
		children: [collapsible ? (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			onClick: () => handleCollapsedChange(true),
			"aria-label": collapseButtonAriaLabel,
			"data-testid": testId ? `${testId}-collapse-inline` : "page-sidebar-collapse-inline",
			className: "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt",
			children: (0, import_jsx_runtime.jsx)(PanelLeftClose, {
				className: "h-3.5 w-3.5",
				"aria-hidden": true
			})
		}) : null, bottomAction]
	}) : void 0);
	return (0, import_jsx_runtime.jsx)(Sidebar, {
		...props,
		ref,
		testId,
		variant,
		collapsible,
		collapsed,
		onCollapsedChange: handleCollapsedChange,
		contentIdentity,
		syncId: resolvedSyncId,
		header,
		footer: defaultFooter,
		showExpandedCollapseButton,
		collapseButtonAriaLabel,
		expandButtonAriaLabel,
		className: joinClassNames(desktopDefaultVariant ? PAGE_SIDEBAR_ROOT_CLASS : void 0, className),
		headerClassName: joinClassNames(desktopDefaultVariant && header == null ? "!h-0 !min-h-0 !p-0 !m-0 !overflow-hidden" : void 0, headerClassName),
		footerClassName: joinClassNames(defaultFooter && desktopDefaultVariant ? PAGE_SIDEBAR_FOOTER_CLASS : void 0, footerClassName),
		collapseButtonClassName: joinClassNames(desktopDefaultVariant ? PAGE_SIDEBAR_COLLAPSE_BUTTON_CLASS : void 0, collapseButtonClassName),
		resizable: effectiveResizable,
		width: effectiveResizable ? width : widthProp,
		onWidthChange: effectiveResizable ? handleWidthChange : onWidthChange,
		minWidth,
		maxWidth,
		onCollapseRequest: onCollapseRequest ?? (() => handleCollapsedChange(true))
	});
});

//#endregion
export { AppPageSidebar as t };