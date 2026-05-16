import { D as require_jsx_runtime, k as __exportAll } from "./electrobun-runtime-zXJ9acDW.js";
import { N as getBootConfig, d as client, n as useApp } from "./useApp-Dh-r7aR7.js";
import { Jr as openExternalUrl } from "./state-BC9WO-N8.js";
import { a as buildPluginListState, c as paramsToSchema, d as subgroupForPlugin, i as TELEGRAM_ALLOW_ALL_HIDDEN, l as pluginResourceLinkLabel, n as SUBGROUP_LABELS, o as getPluginResourceLinks, r as SUBGROUP_NAV_ICONS, s as iconImageSource, u as resolveIcon } from "./plugin-list-utils-D3K7UKwI.js";
import { t as AppPageSidebar } from "./AppPageSidebar-myyOdXbd.js";
import { i as useSignalPairing, t as useWhatsAppPairing } from "./hooks-C3v9uETL.js";
import { a as buildManagedDiscordSettingsReturnUrl, v as resolveManagedDiscordAgentChoice } from "./cloud-dashboard-utils-Dedro-JF.js";
import { ConfigRenderer, defaultRegistry } from "./index.js";
import { AdminDialog, Button, Dialog, DialogDescription, DialogTitle, Input, PageLayoutHeader, PagePanel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SettingsControls, SidebarContent, SidebarHeader, SidebarPanel, SidebarScrollRegion, StatusBadge, Switch, useLinkedSidebarSelection } from "@elizaos/ui";
import { AlertCircle, CheckCircle2, ChevronRight, Package } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/conversations/brand-icons.js
var import_jsx_runtime = require_jsx_runtime();
const baseSvgProps = {
	xmlns: "http://www.w3.org/2000/svg",
	viewBox: "0 0 24 24",
	fill: "currentColor"
};
function makeIcon(path) {
	return function BrandIcon({ className }) {
		return (0, import_jsx_runtime.jsx)("svg", {
			...baseSvgProps,
			"aria-hidden": "true",
			focusable: "false",
			className,
			children: (0, import_jsx_runtime.jsx)("path", { d: path })
		});
	};
}
const DiscordIcon = makeIcon("M20.317 4.369a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037 13.78 13.78 0 0 0-.608 1.25 18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037 19.736 19.736 0 0 0-4.885 1.515.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.077.077 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.075.075 0 0 0-.041-.104 13.107 13.107 0 0 1-1.872-.892.075.075 0 0 1-.008-.125c.126-.094.252-.192.372-.292a.075.075 0 0 1 .078-.01c3.927 1.793 8.18 1.793 12.061 0a.075.075 0 0 1 .079.009c.12.099.246.198.372.293a.075.075 0 0 1-.006.125c-.598.349-1.22.646-1.873.891a.075.075 0 0 0-.04.105c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z");
const TelegramIcon = makeIcon("M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z");
const SlackIcon = makeIcon("M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z");
const XTwitterIcon = makeIcon("M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z");
const WhatsappIcon = makeIcon("M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z");
const InstagramIcon = makeIcon("M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z");
const LineIcon = makeIcon("M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016a.63.63 0 0 1-.631.629.626.626 0 0 1-.51-.252l-2.443-3.317v2.94a.63.63 0 0 1-1.259 0V8.108a.627.627 0 0 1 .628-.629c.195 0 .375.105.502.249l2.443 3.33V8.108a.63.63 0 0 1 1.26 0v4.771zm-5.741 0a.63.63 0 0 1-.629.629.63.63 0 0 1-.63-.629V8.108a.631.631 0 0 1 1.259 0v4.771zm-2.466.629H4.917a.634.634 0 0 1-.631-.629V8.108a.631.631 0 0 1 1.262 0v4.141h1.155a.629.629 0 0 1 0 1.259zM24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314Z");
const ImessageIcon = makeIcon("M12 0C5.373 0 0 4.975 0 11.111c0 3.497 1.745 6.616 4.472 8.652.162 1.08.892 2.61 2.088 3.85.052.054.134.09.213.082.038-.005.957-.178 1.844-.727.392-.243.735-.506 1.024-.768.749.123 1.528.186 2.359.186 6.627 0 12-4.975 12-11.111S18.627 0 12 0z");
const MsTeamsIcon = makeIcon("M20.625 8.127h-6.254a.957.957 0 0 1-.957-.957V0a7.172 7.172 0 0 1 7.21 7.17v.957zM12.458 9.087h8.166c.37 0 .668.299.668.668V16.5c0 3.728-2.87 6.75-6.417 6.75-3.546 0-6.416-3.022-6.416-6.75V9.087h4.0zM8.04 5.523a3.579 3.579 0 1 1 7.158 0 3.579 3.579 0 0 1-7.158 0zM2.99 9.087h5.051c.37 0 .668.299.668.668V16.5c0 3.728-2.522 6.75-5.635 6.75-3.112 0-5.634-3.022-5.634-6.75 0 0 0-6.745 5.55-7.413zM0 9.087c0-2.485 2.016-4.5 4.5-4.5s4.5 2.015 4.5 4.5v.036a3.72 3.72 0 0 0-.918-.036H.918A3.72 3.72 0 0 0 0 9.123v-.036z");
const BRAND_ICONS = {
	discord: DiscordIcon,
	telegram: TelegramIcon,
	slack: SlackIcon,
	twitter: XTwitterIcon,
	x: XTwitterIcon,
	whatsapp: WhatsappIcon,
	instagram: InstagramIcon,
	line: LineIcon,
	imessage: ImessageIcon,
	msteams: MsTeamsIcon,
	teams: MsTeamsIcon,
	microsoftteams: MsTeamsIcon,
	signal: makeIcon("m9.12.35.27 1.09a10.845 10.845 0 0 0-3.015 1.25l-.578-.96A11.955 11.955 0 0 1 9.12.35Zm5.76 0-.27 1.09a10.845 10.845 0 0 1 3.015 1.25l.581-.96A11.955 11.955 0 0 0 14.88.35ZM2.308 5.819a10.94 10.94 0 0 0-1.25 3.014L-.032 8.56a12.05 12.05 0 0 1 1.379-3.323Zm19.634 2.738a10.87 10.87 0 0 0-1.25-3.014l-.96.578a10.845 10.845 0 0 1 1.249 3.015ZM1.068 14.88a10.81 10.81 0 0 1-.01-5.762l-1.09-.271a11.94 11.94 0 0 0 0 6.304Zm20.652-5.762a10.81 10.81 0 0 1 .01 5.762l1.09.271a11.94 11.94 0 0 0 0-6.304ZM2.888 18.185a10.856 10.856 0 0 1-1.566-2.762l-1.054.372a12.01 12.01 0 0 0 1.734 3.053Zm16.262 2.026a10.945 10.945 0 0 1-2.762 1.566l.371 1.054a12.033 12.033 0 0 0 3.052-1.734ZM5.43 20.747a10.84 10.84 0 0 1-2.23-2.23l-.907.659a11.95 11.95 0 0 0 2.48 2.479Zm12.834-18.26a10.856 10.856 0 0 1 2.762 1.566l.747-.854a12.02 12.02 0 0 0-3.053-1.735zM3.2 5.483a10.84 10.84 0 0 1 2.23-2.23l-.657-.907a11.95 11.95 0 0 0-2.479 2.48ZM8.836 22.706a10.815 10.815 0 0 1-2.948-1.093l-2.323.767a.547.547 0 0 1-.692-.691l.767-2.324a10.91 10.91 0 0 1-1.093-2.947l-1.075.305a11.923 11.923 0 0 0 1.04 2.882l-.793 2.403a1.635 1.635 0 0 0 2.069 2.068l2.403-.793a11.896 11.896 0 0 0 2.882 1.04ZM23.885 17.24l-1.053-.374a10.81 10.81 0 0 1-1.566 2.762l.854.747a11.933 11.933 0 0 0 1.735-3.136Zm-11.879 4.944a10.8 10.8 0 0 1-2.868-.383l-.309 1.074a11.935 11.935 0 0 0 6.354 0l-.309-1.074a10.801 10.801 0 0 1-2.868.383z"),
	googlechat: makeIcon("M21 3H3a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h3v4l4.8-4H21a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-13 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z")
};
/**
* Look up a brand icon by a free-form source string (plugin id, display name,
* etc). Normalizes by stripping non-alphanumeric characters so `"google-chat"`,
* `"Google Chat"`, and `"googlechat"` all resolve to the same icon.
*/
function getBrandIcon(source) {
	const normalized = source.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!normalized) return null;
	return BRAND_ICONS[normalized] ?? null;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/PluginCard.js
function PluginCard({ plugin: p, allowCustomOrder, pluginSettingsOpen, togglingPlugins, hasPluginToggleInFlight, installingPlugins, updatingPlugins, uninstallingPlugins, installProgress, releaseStreamSelections, draggingId, dragOverId, pluginDescriptionFallback, onToggle, onToggleSettings, onInstall, onUpdate, onUninstall, onReleaseStreamChange, onOpenExternalUrl, onDragStart, onDragOver, onDrop, onDragEnd, installProgressLabel, installLabel, loadFailedLabel, notInstalledLabel }) {
	const { t } = useApp();
	const hasParams = p.parameters && p.parameters.length > 0;
	const isOpen = pluginSettingsOpen.has(p.id);
	const requiredParams = hasParams ? p.parameters.filter((param) => param.required) : [];
	const requiredSetCount = requiredParams.filter((param) => param.isSet).length;
	const setCount = hasParams ? p.parameters.filter((param) => param.isSet).length : 0;
	const totalCount = hasParams ? p.parameters.length : 0;
	const allParamsSet = !hasParams || requiredParams.length === 0 || requiredSetCount === requiredParams.length;
	const isShowcase = p.id === "__ui-showcase__";
	const selectedReleaseStream = releaseStreamSelections[p.id] ?? p.releaseStream ?? (p.alphaVersion ? "alpha" : "latest");
	const remoteVersionForSelection = selectedReleaseStream === "alpha" ? p.alphaVersion : p.latestVersion;
	const showReleaseControls = !isShowcase && Boolean(p.npmName);
	const canUpdate = showReleaseControls && Boolean(p.version);
	const canUninstall = !isShowcase && p.source === "store" && Boolean(p.npmName);
	const isInstalling = installingPlugins.has(p.id);
	const isUpdating = updatingPlugins.has(p.id);
	const isUninstalling = uninstallingPlugins.has(p.id);
	const categoryLabel = isShowcase ? "showcase" : p.category === "ai-provider" ? "ai provider" : p.category;
	const notLoadedLabel = t("pluginsview.NotLoaded", { defaultValue: "Not loaded" });
	const isStoreInstallMissing = p.source === "store" && p.enabled && !p.isActive && Boolean(p.npmName);
	const inactiveLabel = p.loadError ? loadFailedLabel : p.source === "store" ? notInstalledLabel : notLoadedLabel;
	const enabledBorder = isShowcase ? "border-l-[3px] border-l-accent" : p.enabled ? !allParamsSet && hasParams ? "border-l-[3px] border-l-warn" : "border-l-[3px] border-l-accent" : "";
	const isToggleBusy = togglingPlugins.has(p.id);
	const toggleDisabled = isToggleBusy || hasPluginToggleInFlight && !isToggleBusy;
	const isDragging = draggingId === p.id;
	const isDragOver = dragOverId === p.id && draggingId !== p.id;
	const pluginLinks = getPluginResourceLinks(p);
	return (0, import_jsx_runtime.jsxs)("li", {
		draggable: allowCustomOrder,
		onDragStart: allowCustomOrder && onDragStart ? (e) => onDragStart(e, p.id) : void 0,
		onDragOver: allowCustomOrder && onDragOver ? (e) => onDragOver(e, p.id) : void 0,
		onDrop: allowCustomOrder && onDrop ? (e) => onDrop(e, p.id) : void 0,
		onDragEnd: allowCustomOrder ? onDragEnd : void 0,
		className: `border border-border bg-card transition-colors duration-150 flex flex-col ${enabledBorder} ${isOpen ? "ring-1 ring-accent" : "hover:border-accent/40"} ${isDragging ? "opacity-30" : ""} ${isDragOver ? "ring-2 ring-accent/60" : ""}`,
		"data-plugin-id": p.id,
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 px-3 pt-3 pb-1",
				children: [
					allowCustomOrder && (0, import_jsx_runtime.jsx)("span", {
						className: "text-2xs text-muted opacity-30 hover:opacity-70 cursor-grab active:cursor-grabbing shrink-0 select-none leading-none",
						title: t("pluginsview.DragToReorder"),
						children: t("pluginsview.X2807")
					}),
					(0, import_jsx_runtime.jsxs)("span", {
						className: "font-bold text-sm flex items-center gap-1.5 min-w-0 truncate flex-1",
						children: [(() => {
							const icon = resolveIcon(p);
							if (!icon) return null;
							if (typeof icon === "string") {
								const imageSrc = iconImageSource(icon);
								return imageSrc ? (0, import_jsx_runtime.jsx)("img", {
									src: imageSrc,
									alt: "",
									className: "w-5 h-5 rounded-sm object-contain",
									onError: (e) => {
										e.currentTarget.style.display = "none";
									}
								}) : (0, import_jsx_runtime.jsx)("span", {
									className: "text-sm",
									children: icon
								});
							}
							return (0, import_jsx_runtime.jsx)(icon, { className: "w-5 h-5" });
						})(), p.name]
					}),
					isShowcase ? (0, import_jsx_runtime.jsx)("span", {
						className: "text-2xs font-bold tracking-wider px-2.5 py-[2px] border border-accent text-txt bg-accent-subtle shrink-0",
						children: t("pluginsview.DEMO")
					}) : (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						"data-plugin-toggle": p.id,
						className: `text-2xs font-bold tracking-wider px-2.5 py-[2px] h-auto rounded-none border transition-colors duration-150 shrink-0 ${p.enabled ? "bg-accent text-accent-fg border-accent" : "bg-transparent text-muted border-border hover:text-txt"} ${toggleDisabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`,
						onClick: (e) => {
							e.stopPropagation();
							onToggle(p.id, !p.enabled);
						},
						disabled: toggleDisabled,
						children: isToggleBusy ? t("pluginsview.Applying", { defaultValue: "Applying" }) : p.enabled ? t("common.on") : t("common.off")
					})
				]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-1.5 px-3 pb-1.5",
				children: [
					(0, import_jsx_runtime.jsx)("span", {
						className: "text-2xs px-1.5 py-px border border-border bg-surface text-muted lowercase tracking-wide whitespace-nowrap",
						children: categoryLabel
					}),
					p.version && (0, import_jsx_runtime.jsxs)("span", {
						className: "text-2xs font-mono text-muted opacity-70",
						children: ["v", p.version]
					}),
					showReleaseControls && (0, import_jsx_runtime.jsx)("span", {
						className: "text-2xs px-1.5 py-px border border-border bg-surface text-muted lowercase tracking-wide whitespace-nowrap",
						children: selectedReleaseStream
					}),
					p.enabled && !p.isActive && !isShowcase && (0, import_jsx_runtime.jsx)("span", {
						className: `text-2xs px-1.5 py-px border lowercase tracking-wide whitespace-nowrap ${p.loadError ? "border-destructive bg-[rgba(153,27,27,0.04)] text-destructive" : "border-warn bg-[rgba(234,179,8,0.06)] text-warn"}`,
						title: p.loadError || "Plugin is enabled but not loaded in the runtime",
						children: inactiveLabel
					}),
					isToggleBusy && (0, import_jsx_runtime.jsx)("span", {
						className: "text-2xs px-1.5 py-px border border-accent bg-accent-subtle text-txt lowercase tracking-wide whitespace-nowrap",
						children: t("pluginsview.restarting")
					})
				]
			}),
			(0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-muted px-3 pb-2 flex-1",
				style: {
					display: "-webkit-box",
					WebkitLineClamp: 3,
					WebkitBoxOrient: "vertical",
					overflow: "hidden"
				},
				children: p.description || pluginDescriptionFallback
			}),
			(p.tags?.length ?? 0) > 0 && (0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-wrap gap-1.5 px-3 pb-2",
				children: p.tags?.slice(0, 4).map((tag) => (0, import_jsx_runtime.jsx)("span", {
					className: "whitespace-nowrap border border-border/50 bg-bg-accent/80 px-1.5 py-px text-2xs lowercase tracking-wide text-muted-strong",
					children: tag
				}, `${p.id}:${tag}`))
			}),
			pluginLinks.length > 0 && (0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-wrap gap-2 px-3 pb-2",
				children: pluginLinks.map((link) => (0, import_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-6 px-2 text-2xs font-bold border-border/40 text-muted hover:text-txt hover:border-accent hover:bg-accent/5 backdrop-blur-sm transition-all",
					onClick: (e) => {
						e.stopPropagation();
						onOpenExternalUrl(link.url);
					},
					title: `${pluginResourceLinkLabel(t, link.key)}: ${link.url}`,
					children: pluginResourceLinkLabel(t, link.key)
				}, `${p.id}:${link.key}`))
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mt-auto flex items-center gap-3 bg-card/55 px-4 py-3",
				children: [
					hasParams && !isShowcase ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)("span", { className: `inline-block w-2 h-2 rounded-full shadow-[0_0_10px_currentColor] shrink-0 ${allParamsSet ? "bg-ok text-ok" : "bg-destructive text-destructive"}` }), (0, import_jsx_runtime.jsxs)("span", {
						className: "text-xs-tight font-bold tracking-wide text-muted",
						children: [
							setCount,
							"/",
							totalCount,
							" ",
							t("common.configured")
						]
					})] }) : !hasParams && !isShowcase ? (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs-tight font-bold tracking-wide text-muted/60",
						children: t("pluginsview.NoConfigNeeded")
					}) : (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs-tight font-bold tracking-wide text-muted/60",
						children: t("pluginsview.23FieldDemos")
					}),
					showReleaseControls && (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-1",
						children: [(0, import_jsx_runtime.jsx)(Button, {
							variant: selectedReleaseStream === "latest" ? "default" : "outline",
							size: "sm",
							className: "h-6 px-2 text-2xs font-bold tracking-wide",
							onClick: (e) => {
								e.stopPropagation();
								onReleaseStreamChange(p.id, "latest");
							},
							children: "main"
						}), (0, import_jsx_runtime.jsx)(Button, {
							variant: selectedReleaseStream === "alpha" ? "default" : "outline",
							size: "sm",
							className: "h-6 px-2 text-2xs font-bold tracking-wide",
							onClick: (e) => {
								e.stopPropagation();
								onReleaseStreamChange(p.id, "alpha");
							},
							children: "alpha"
						})]
					}),
					showReleaseControls && remoteVersionForSelection && (0, import_jsx_runtime.jsxs)("span", {
						className: "text-2xs font-mono text-muted/70 whitespace-nowrap",
						children: [
							selectedReleaseStream,
							":",
							remoteVersionForSelection
						]
					}),
					(0, import_jsx_runtime.jsx)("div", { className: "flex-1" }),
					isStoreInstallMissing && !isShowcase && !p.loadError && (0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "h-7 px-3 text-2xs font-bold tracking-wide shadow-sm max-w-[140px] truncate",
						disabled: isInstalling || isUpdating || isUninstalling,
						onClick: (e) => {
							e.stopPropagation();
							onInstall(p.id, p.npmName ?? "");
						},
						children: isInstalling ? installProgressLabel(installProgress.get(p.npmName ?? "")?.message) : installLabel
					}),
					canUpdate && (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-7 px-3 text-2xs font-bold tracking-wide",
						disabled: isInstalling || isUpdating || isUninstalling,
						onClick: (e) => {
							e.stopPropagation();
							onUpdate(p.id, p.npmName ?? "");
						},
						children: isUpdating ? t("common.updating", { defaultValue: "Updating..." }) : t("pluginsview.Update", { defaultValue: "Update" })
					}),
					canUninstall && (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-7 px-3 text-2xs font-bold tracking-wide text-destructive border-destructive/40 hover:border-destructive",
						disabled: isInstalling || isUpdating || isUninstalling,
						onClick: (e) => {
							e.stopPropagation();
							onUninstall(p.id, p.npmName ?? "");
						},
						children: isUninstalling ? t("pluginsview.Uninstalling", { defaultValue: "Uninstalling..." }) : t("common.uninstall", { defaultValue: "Uninstall" })
					}),
					hasParams && (0, import_jsx_runtime.jsxs)(Button, {
						variant: "ghost",
						size: "sm",
						className: `h-7 px-2.5 text-xs-tight font-bold transition-all flex items-center gap-1.5 ${isOpen ? "text-txt bg-accent/10 hover:bg-accent/20" : "text-muted hover:bg-bg-hover hover:text-txt"}`,
						onClick: (e) => {
							e.stopPropagation();
							onToggleSettings(p.id);
						},
						title: t("nav.settings"),
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "text-sm leading-none",
							children: "⚙"
						}), (0, import_jsx_runtime.jsx)("span", {
							className: `inline-block text-2xs transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`,
							children: "▶"
						})]
					})
				]
			}),
			p.enabled && p.validationErrors && p.validationErrors.length > 0 && (0, import_jsx_runtime.jsx)("div", {
				className: "px-3 py-1.5 border-t border-destructive bg-[rgba(153,27,27,0.04)] text-xs",
				children: p.validationErrors.map((err) => (0, import_jsx_runtime.jsxs)("div", {
					className: "text-destructive mb-0.5 text-2xs",
					children: [
						err.field,
						": ",
						err.message
					]
				}, `${err.field}:${err.message}`))
			}),
			p.enabled && p.validationWarnings && p.validationWarnings.length > 0 && (0, import_jsx_runtime.jsx)("div", {
				className: "px-3 py-1",
				children: p.validationWarnings.map((w) => (0, import_jsx_runtime.jsx)("div", {
					className: "text-warn text-2xs",
					children: w.message
				}, `${w.field}:${w.message}`))
			})
		]
	}, p.id);
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/connectors/ConnectorModeSelector.js
/**
* Returns available modes for each connector based on deployment context.
*/
function getConnectorModes(connectorId, options) {
	const cloud = options?.elizaCloudConnected ?? false;
	switch (connectorId) {
		case "discord": return [
			...cloud ? [{
				id: "managed",
				label: "OAuth Gateway",
				description: "Invite the shared Eliza Cloud Discord gateway, nickname it to your agent, and route messages down to this app."
			}] : [],
			{
				id: "local",
				label: "Desktop App",
				description: "Connect via local Discord desktop app (IPC)"
			},
			{
				id: "bot",
				label: "Bot Token",
				description: "Use your own Discord bot with a token from the Developer Portal"
			}
		];
		case "telegram": return [
			...cloud ? [{
				id: "cloud-bot",
				label: "Cloud Gateway",
				description: "Telegram bot communication still starts with a BotFather token; Eliza Cloud can host the webhook and route it to this app."
			}] : [],
			{
				id: "bot",
				label: "Bot Token",
				description: "Create a bot via @BotFather and paste the token"
			},
			{
				id: "account",
				label: "Personal Account",
				description: "Use your own Telegram account (requires app credentials from my.telegram.org)"
			}
		];
		case "slack": return [...cloud ? [{
			id: "oauth",
			label: "OAuth",
			description: "Connect Slack through Eliza Cloud OAuth for workspace-scoped bidirectional access."
		}] : [], {
			id: "socket",
			label: "Socket Mode Tokens",
			description: "Use your own Slack app token and bot token for the local connector runtime."
		}];
		case "twitter": return [
			...cloud ? [{
				id: "oauth",
				label: "OAuth",
				description: "Connect X/Twitter through Eliza Cloud OAuth so the agent can post, read mentions, and handle DMs through cloud-held tokens."
			}] : [],
			{
				id: "local-oauth",
				label: "Local OAuth2",
				description: "Use @elizaos/plugin-x with TWITTER_AUTH_MODE=oauth, a client ID, and a loopback redirect URI."
			},
			{
				id: "developer",
				label: "Developer Tokens",
				description: "Use OAuth 1.0a API keys and access tokens from the X Developer Portal."
			}
		];
		case "signal": return [{
			id: "qr",
			label: "QR Pair",
			description: "Link as a device to your Signal account via QR code"
		}];
		case "whatsapp": return [{
			id: "qr",
			label: "QR Pair",
			description: "Scan a QR code from your WhatsApp mobile app"
		}, {
			id: "business",
			label: "Business Cloud API",
			description: "Use WhatsApp Business API with access token and phone number ID"
		}];
		case "imessage": return [
			{
				id: "direct",
				label: "Direct (chat.db)",
				description: "Read iMessage database directly on this Mac. Requires Full Disk Access."
			},
			{
				id: "bluebubbles",
				label: "BlueBubbles",
				description: "Bridge via BlueBubbles server app. Works locally or over network."
			},
			...cloud ? [{
				id: "blooio",
				label: "Blooio (Cloud)",
				description: "Cloud-based iMessage/SMS gateway. No Mac needed on the server."
			}] : []
		];
		default: return [];
	}
}
/**
* Maps connector mode to the plugin ID that ConnectorSetupPanel renders.
*/
function modeToSetupPluginId(connectorId, modeId) {
	return {
		discord: {
			local: "discordlocal",
			bot: "discord",
			managed: "discord"
		},
		telegram: {
			"cloud-bot": "telegram",
			bot: "telegram",
			account: "telegramaccount"
		},
		slack: {
			oauth: "slack",
			socket: "slack"
		},
		twitter: {
			oauth: "twitter",
			"local-oauth": "twitter",
			developer: "twitter"
		},
		signal: { qr: "signal" },
		whatsapp: {
			qr: "whatsapp",
			business: "whatsapp"
		},
		imessage: {
			direct: "imessage",
			bluebubbles: "bluebubbles",
			blooio: "blooio"
		}
	}[connectorId]?.[modeId] ?? null;
}
function getDefaultConnectorModeId(connectorId, modes) {
	for (const preferred of {
		discord: ["bot"],
		slack: ["oauth", "socket"],
		telegram: ["bot"],
		twitter: ["oauth", "local-oauth"]
	}[connectorId] ?? []) if (modes.some((mode) => mode.id === preferred)) return preferred;
	return modes[0]?.id ?? "";
}
function ConnectorModeSelector({ connectorId, selectedMode, onModeChange, elizaCloudConnected }) {
	const { t } = useApp();
	const modes = getConnectorModes(connectorId, { elizaCloudConnected });
	if (modes.length <= 1) return null;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "mb-4",
		children: [
			(0, import_jsx_runtime.jsx)("div", {
				className: "mb-2 text-xs font-semibold text-muted",
				children: t("pluginsview.ConnectionMode", { defaultValue: "Connection mode" })
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-wrap gap-2",
				children: modes.map((mode) => (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					"data-testid": `connector-mode-${connectorId}-${mode.id}`,
					onClick: () => onModeChange(mode.id),
					className: `rounded-xl border px-3 py-1.5 text-xs-tight font-medium transition-all ${selectedMode === mode.id ? "border-accent bg-accent/10 text-accent" : "border-border/40 bg-card/40 text-muted hover:border-accent/40 hover:text-txt"}`,
					title: mode.description,
					children: mode.label
				}, mode.id))
			}),
			modes.find((m) => m.id === selectedMode)?.description && (0, import_jsx_runtime.jsx)("div", {
				className: "mt-1.5 text-2xs text-muted",
				children: modes.find((m) => m.id === selectedMode)?.description
			})
		]
	});
}
/**
* Hook to manage connector mode state. Reads initial mode from config
* or defaults to the first available mode.
*/
function useConnectorMode(connectorId, options) {
	const modes = getConnectorModes(connectorId, options);
	const defaultMode = getDefaultConnectorModeId(connectorId, modes);
	const [selectedMode, setSelectedMode] = useState(defaultMode);
	useEffect(() => {
		if (!modes.some((mode) => mode.id === selectedMode)) setSelectedMode(defaultMode);
	}, [
		defaultMode,
		modes,
		selectedMode
	]);
	return {
		modes,
		selectedMode,
		setSelectedMode,
		setupPluginId: modeToSetupPluginId(connectorId, selectedMode)
	};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/connectors/BlueBubblesStatusPanel.js
function resolveWebhookTarget(status) {
	if (!status?.webhookPath) return null;
	const baseUrl = client.getBaseUrl();
	if (typeof baseUrl === "string" && /^https?:\/\//.test(baseUrl)) return new URL(status.webhookPath, `${baseUrl}/`).toString();
	if (typeof window !== "undefined" && (window.location.protocol === "http:" || window.location.protocol === "https:")) return new URL(status.webhookPath, window.location.origin).toString();
	return status.webhookPath;
}
function BlueBubblesStatusPanel() {
	const { t } = useApp();
	const [status, setStatus] = useState(null);
	const [error, setError] = useState(null);
	const [loading, setLoading] = useState(true);
	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setStatus(await client.getBlueBubblesStatus());
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		refresh();
		return client.onWsEvent("ws-reconnected", () => {
			refresh();
		});
	}, [refresh]);
	const webhookTarget = resolveWebhookTarget(status);
	return (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
		tone: error ? "danger" : status?.connected ? "accent" : "default",
		className: "mt-4",
		actions: (0, import_jsx_runtime.jsx)(Button, {
			variant: "outline",
			size: "sm",
			className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
			onClick: () => {
				refresh();
			},
			disabled: loading,
			children: loading ? t("common.loading", { defaultValue: "Loading…" }) : t("common.refresh", { defaultValue: "Refresh" })
		}),
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "space-y-2 text-xs",
			children: [
				(0, import_jsx_runtime.jsx)("div", {
					className: "font-semibold text-txt",
					children: status?.connected ? t("pluginsview.BlueBubblesConnected", { defaultValue: "BlueBubbles is connected." }) : t("pluginsview.BlueBubblesNotConnected", { defaultValue: "BlueBubbles is not connected yet. Save the server URL and password above, then refresh." })
				}),
				error ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-danger",
					children: error
				}) : null,
				!error && status?.reason ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: status.reason
				}) : null,
				webhookTarget ? (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-1",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "font-medium text-txt",
						children: t("pluginsview.BlueBubblesWebhookTarget", { defaultValue: "Webhook target" })
					}), (0, import_jsx_runtime.jsx)("code", {
						className: "block break-all rounded-lg border border-border/40 bg-bg/70 px-3 py-2 text-xs-tight text-muted-strong",
						children: webhookTarget
					})]
				}) : null,
				(0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: t("pluginsview.BlueBubblesWebhookHint", { defaultValue: "Point your BlueBubbles webhook at the app API host so new iMessage events stream into the inbox." })
				})
			]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/connectors/DiscordLocalConnectorPanel.js
const DISCORD_TEXT_CHANNEL_TYPES = new Set([
	0,
	5,
	10,
	11,
	12,
	15,
	16
]);
function isTextLikeChannel(channel) {
	if (typeof channel.type !== "number") return true;
	return DISCORD_TEXT_CHANNEL_TYPES.has(channel.type);
}
function channelLabel(channel) {
	if (typeof channel.name === "string" && channel.name.trim().length > 0) return `#${channel.name.trim()}`;
	if (Array.isArray(channel.recipients) && channel.recipients.length > 0) return channel.recipients.map((recipient) => recipient.global_name?.trim() || recipient.username?.trim() || recipient.id).join(", ");
	return channel.id;
}
function currentUserLabel(status) {
	const currentUser = status?.currentUser;
	if (!currentUser) return null;
	return currentUser.global_name?.trim() || currentUser.username?.trim() || null;
}
function selectedChannelIdsFromStatus(status) {
	return status.subscribedChannelIds.length > 0 ? status.subscribedChannelIds : status.configuredChannelIds;
}
function DiscordLocalConnectorPanel() {
	const { t } = useApp();
	const [status, setStatus] = useState(null);
	const [guilds, setGuilds] = useState([]);
	const [channels, setChannels] = useState([]);
	const [selectedGuildId, setSelectedGuildId] = useState("");
	const [selectedChannelIds, setSelectedChannelIds] = useState([]);
	const [loadingStatus, setLoadingStatus] = useState(true);
	const [loadingGuilds, setLoadingGuilds] = useState(false);
	const [loadingChannels, setLoadingChannels] = useState(false);
	const [authorizing, setAuthorizing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [disconnecting, setDisconnecting] = useState(false);
	const [error, setError] = useState(null);
	const [saveMessage, setSaveMessage] = useState(null);
	const applyStatus = useCallback((nextStatus) => {
		setStatus(nextStatus);
		setSelectedChannelIds(selectedChannelIdsFromStatus(nextStatus));
	}, []);
	const refreshStatus = useCallback(async () => {
		setLoadingStatus(true);
		setError(null);
		try {
			applyStatus(await client.getDiscordLocalStatus());
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoadingStatus(false);
		}
	}, [applyStatus]);
	const loadGuilds = useCallback(async () => {
		setLoadingGuilds(true);
		setError(null);
		try {
			const response = await client.listDiscordLocalGuilds();
			setGuilds(response.guilds);
			setSelectedGuildId((current) => {
				if (current && response.guilds.some((guild) => guild.id === current)) return current;
				return response.guilds[0]?.id ?? "";
			});
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
			setGuilds([]);
			setSelectedGuildId("");
		} finally {
			setLoadingGuilds(false);
		}
	}, []);
	const loadChannels = useCallback(async (guildId) => {
		if (!guildId) {
			setChannels([]);
			return;
		}
		setLoadingChannels(true);
		setError(null);
		try {
			setChannels((await client.listDiscordLocalChannels(guildId)).channels.filter(isTextLikeChannel));
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
			setChannels([]);
		} finally {
			setLoadingChannels(false);
		}
	}, []);
	useEffect(() => {
		refreshStatus();
		return client.onWsEvent("ws-reconnected", () => {
			refreshStatus();
		});
	}, [refreshStatus]);
	useEffect(() => {
		if (!status?.authenticated) {
			setGuilds([]);
			setChannels([]);
			setSelectedGuildId("");
			return;
		}
		loadGuilds();
	}, [loadGuilds, status?.authenticated]);
	useEffect(() => {
		if (!status?.authenticated || !selectedGuildId) {
			setChannels([]);
			return;
		}
		loadChannels(selectedGuildId);
	}, [
		loadChannels,
		selectedGuildId,
		status?.authenticated
	]);
	const toggleChannel = useCallback((channelId) => {
		setSelectedChannelIds((current) => current.includes(channelId) ? current.filter((entry) => entry !== channelId) : [...current, channelId]);
		setSaveMessage(null);
	}, []);
	const handleAuthorize = useCallback(async () => {
		setAuthorizing(true);
		setError(null);
		setSaveMessage(null);
		try {
			applyStatus(await client.authorizeDiscordLocal());
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setAuthorizing(false);
		}
	}, [applyStatus]);
	const handleDisconnect = useCallback(async () => {
		setDisconnecting(true);
		setError(null);
		setSaveMessage(null);
		try {
			await client.disconnectDiscordLocal();
			await refreshStatus();
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setDisconnecting(false);
		}
	}, [refreshStatus]);
	const handleSaveSubscriptions = useCallback(async () => {
		setSaving(true);
		setError(null);
		setSaveMessage(null);
		try {
			const response = await client.saveDiscordLocalSubscriptions(selectedChannelIds);
			setStatus((current) => current ? {
				...current,
				subscribedChannelIds: response.subscribedChannelIds,
				configuredChannelIds: response.subscribedChannelIds
			} : current);
			setSelectedChannelIds(response.subscribedChannelIds);
			setSaveMessage(t("pluginsview.DiscordLocalSubscriptionsSaved", { defaultValue: "Channel subscriptions saved." }));
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setSaving(false);
		}
	}, [selectedChannelIds, t]);
	const connectedUser = currentUserLabel(status);
	return (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
		tone: error ? "danger" : status?.authenticated ? "accent" : "default",
		className: "mt-4",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "space-y-3 text-xs",
			children: [
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap items-center gap-2",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "font-semibold text-txt",
						children: status?.authenticated ? t("pluginsview.DiscordLocalAuthorized", { defaultValue: "Discord desktop is authorized." }) : t("pluginsview.DiscordLocalAuthorizePrompt", { defaultValue: "Authorize the app against the local Discord desktop app to read notifications, subscribe to channels, and send replies through macOS UI automation." })
					}), connectedUser ? (0, import_jsx_runtime.jsx)("code", {
						className: "rounded-md border border-border/40 bg-bg/60 px-2 py-1 text-xs-tight text-muted-strong",
						children: connectedUser
					}) : null]
				}),
				status?.ipcPath ? (0, import_jsx_runtime.jsxs)("div", {
					className: "text-muted",
					children: [
						t("pluginsview.DiscordLocalIpcPath", { defaultValue: "Discord IPC socket" }),
						":",
						" ",
						(0, import_jsx_runtime.jsx)("code", {
							className: "text-xs-tight text-muted-strong",
							children: status.ipcPath
						})
					]
				}) : null,
				status?.lastError ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-danger",
					children: status.lastError
				}) : null,
				error ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-danger",
					children: error
				}) : null,
				saveMessage ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-ok",
					children: saveMessage
				}) : null,
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap items-center gap-2",
					children: [
						(0, import_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
							onClick: () => {
								refreshStatus();
							},
							disabled: loadingStatus,
							children: loadingStatus ? t("common.loading", { defaultValue: "Loading…" }) : t("common.refresh", { defaultValue: "Refresh" })
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							variant: "default",
							size: "sm",
							className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
							onClick: () => {
								handleAuthorize();
							},
							disabled: authorizing || !status?.available,
							children: authorizing ? t("pluginsview.DiscordLocalAuthorizing", { defaultValue: "Authorizing…" }) : t("pluginsview.DiscordLocalAuthorize", { defaultValue: "Authorize Discord desktop" })
						}),
						status?.authenticated ? (0, import_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
							onClick: () => {
								handleDisconnect();
							},
							disabled: disconnecting,
							children: disconnecting ? t("common.disconnecting", { defaultValue: "Disconnecting…" }) : t("common.disconnect")
						}) : null
					]
				}),
				!status?.available ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: t("pluginsview.DiscordLocalUnavailable", { defaultValue: "Save the local Discord client ID and client secret above, enable the connector, and keep the Discord desktop app running on this Mac." })
				}) : null,
				status?.authenticated ? (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-3 rounded-xl border border-border/40 bg-bg/60 p-3",
					children: [
						(0, import_jsx_runtime.jsx)("div", {
							className: "text-muted",
							children: t("pluginsview.DiscordLocalSubscriptionsHint", { defaultValue: "Select guild text channels to ingest directly. Direct-message notifications still flow through Discord RPC even without a subscribed channel list." })
						}),
						guilds.length > 0 ? (0, import_jsx_runtime.jsxs)("label", {
							className: "block space-y-1",
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: "font-medium text-txt",
								children: t("common.server", { defaultValue: "Server" })
							}), (0, import_jsx_runtime.jsx)("select", {
								className: "h-9 w-full rounded-xl border border-border/40 bg-bg px-3 text-sm text-txt",
								value: selectedGuildId,
								onChange: (event) => setSelectedGuildId(event.target.value),
								disabled: loadingGuilds,
								children: guilds.map((guild) => (0, import_jsx_runtime.jsx)("option", {
									value: guild.id,
									children: guild.name
								}, guild.id))
							})]
						}) : loadingGuilds ? (0, import_jsx_runtime.jsx)("div", {
							className: "text-muted",
							children: t("pluginsview.DiscordLocalLoadingGuilds", { defaultValue: "Loading Discord servers…" })
						}) : (0, import_jsx_runtime.jsx)("div", {
							className: "text-muted",
							children: t("pluginsview.DiscordLocalNoGuilds", { defaultValue: "No guilds were returned by the local Discord session." })
						}),
						selectedGuildId ? (0, import_jsx_runtime.jsxs)("div", {
							className: "space-y-2",
							children: [
								(0, import_jsx_runtime.jsx)("div", {
									className: "font-medium text-txt",
									children: t("pluginsview.DiscordLocalChannels", { defaultValue: "Subscribed channels" })
								}),
								loadingChannels ? (0, import_jsx_runtime.jsx)("div", {
									className: "text-muted",
									children: t("pluginsview.DiscordLocalLoadingChannels", { defaultValue: "Loading channels…" })
								}) : channels.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
									className: "max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border/30 bg-bg/40 p-2",
									children: channels.map((channel) => {
										return (0, import_jsx_runtime.jsxs)("label", {
											className: "flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-bg-hover",
											children: [(0, import_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: selectedChannelIds.includes(channel.id),
												onChange: () => toggleChannel(channel.id)
											}), (0, import_jsx_runtime.jsx)("span", {
												className: "min-w-0 flex-1 truncate text-sm text-txt",
												children: channelLabel(channel)
											})]
										}, channel.id);
									})
								}) : (0, import_jsx_runtime.jsx)("div", {
									className: "text-muted",
									children: t("pluginsview.DiscordLocalNoChannels", { defaultValue: "No text channels were returned for the selected server." })
								}),
								(0, import_jsx_runtime.jsxs)("div", {
									className: "flex flex-wrap items-center gap-2",
									children: [(0, import_jsx_runtime.jsx)(Button, {
										variant: "default",
										size: "sm",
										className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
										onClick: () => {
											handleSaveSubscriptions();
										},
										disabled: saving,
										children: saving ? t("common.saving", { defaultValue: "Saving..." }) : t("pluginsview.SaveChannelSubscriptions", { defaultValue: "Save channel subscriptions" })
									}), (0, import_jsx_runtime.jsx)("span", {
										className: "text-muted",
										children: t("pluginsview.DiscordLocalSelectedCount", {
											count: selectedChannelIds.length,
											defaultValue: "{{count}} selected"
										})
									})]
								})
							]
						}) : null
					]
				}) : null
			]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/connectors/IMessageStatusPanel.js
function IMessageStatusPanel() {
	const { t } = useApp();
	const [status, setStatus] = useState(null);
	const [error, setError] = useState(null);
	const [loading, setLoading] = useState(true);
	const permissionAction = status?.permissionAction?.type === "full_disk_access" ? status.permissionAction : null;
	const isSendOnly = status?.sendOnly === true;
	const canReadMessages = status?.connected === true && status?.chatDbAvailable === true;
	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setStatus(await client.getIMessageStatus());
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		refresh();
		return client.onWsEvent("ws-reconnected", () => {
			refresh();
		});
	}, [refresh]);
	return (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
		tone: error ? "danger" : permissionAction || isSendOnly ? "warning" : status?.connected ? "accent" : "default",
		className: "mt-4",
		actions: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-wrap items-center gap-2",
			children: [permissionAction ? (0, import_jsx_runtime.jsx)(Button, {
				variant: "default",
				size: "sm",
				className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
				onClick: () => {
					openExternalUrl(permissionAction.url);
				},
				children: t("pluginsview.IMessageOpenFullDiskAccess", { defaultValue: permissionAction.label })
			}) : null, (0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
				onClick: () => {
					refresh();
				},
				disabled: loading,
				children: loading ? t("common.loading", { defaultValue: "Loading…" }) : t("common.refresh", { defaultValue: "Refresh" })
			})]
		}),
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "space-y-2 text-xs",
			children: [
				(0, import_jsx_runtime.jsx)("div", {
					className: "font-semibold text-txt",
					children: canReadMessages ? t("pluginsview.IMessageConnected", { defaultValue: "iMessage is connected. Messages are being read from the local database." }) : isSendOnly ? t("pluginsview.IMessageSendOnly", { defaultValue: "iMessage can send, but Eliza cannot read local messages until Full Disk Access is granted." }) : t("pluginsview.IMessageNotConnected", { defaultValue: "iMessage is not connected. Eliza uses the native macOS Messages bridge on this machine." })
				}),
				error ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-danger",
					children: error
				}) : null,
				!error && status?.reason ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: status.reason
				}) : null,
				status?.chatDbPath ? (0, import_jsx_runtime.jsxs)("div", {
					className: "text-muted",
					children: ["Database: ", status.chatDbPath]
				}) : null,
				status?.bridgeType ? (0, import_jsx_runtime.jsxs)("div", {
					className: "text-muted",
					children: ["Bridge: ", status.bridgeType]
				}) : null,
				permissionAction ? (0, import_jsx_runtime.jsx)("ol", {
					className: "list-decimal space-y-1 pl-4 text-muted",
					children: permissionAction.instructions.map((instruction) => (0, import_jsx_runtime.jsx)("li", { children: instruction }, instruction))
				}) : null,
				(0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: t("pluginsview.IMessagePermissionHint", { defaultValue: "iMessage reads ~/Library/Messages/chat.db directly. Full Disk Access must be granted to Eliza Desktop, or to Terminal/iTerm when running Eliza from a shell." })
				})
			]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/connectors/SignalQrOverlay.js
function SignalQrOverlay({ accountId = "default", onConnected }) {
	const { status, qrDataUrl, phoneNumber, error, startPairing, stopPairing, disconnect } = useSignalPairing(accountId);
	const { t } = useApp();
	const firedRef = useRef(false);
	useEffect(() => {
		if (status !== "connected" || !onConnected || firedRef.current) return;
		firedRef.current = true;
		const timer = setTimeout(onConnected, 1200);
		return () => clearTimeout(timer);
	}, [onConnected, status]);
	if (status === "connected") return (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-3 p-4 border border-ok bg-[var(--ok-subtle)]",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2",
				children: [(0, import_jsx_runtime.jsx)("span", { className: "inline-block h-2 w-2 rounded-full bg-ok" }), (0, import_jsx_runtime.jsxs)("span", {
					className: "text-xs font-medium text-ok",
					children: [t("common.connected"), phoneNumber ? ` (${phoneNumber})` : ""]
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "mt-1 text-2xs text-muted",
				children: onConnected ? "Finishing Signal setup..." : "Signal is paired. Auth state is saved for automatic reconnection."
			}),
			!onConnected ? (0, import_jsx_runtime.jsx)(Button, {
				variant: "destructive",
				size: "sm",
				className: "mt-2 text-2xs",
				onClick: () => void disconnect(),
				children: t("common.disconnect")
			}) : null
		]
	});
	if (status === "error" || status === "timeout") return (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-3 p-4 border border-danger bg-[var(--destructive-subtle)]",
		children: [(0, import_jsx_runtime.jsx)("div", {
			className: "mb-2 text-xs text-danger",
			children: status === "timeout" ? "Signal pairing timed out. Start a new session and scan again." : error ?? "Signal pairing failed."
		}), (0, import_jsx_runtime.jsx)(Button, {
			variant: "outline",
			size: "sm",
			className: "text-xs-tight",
			style: {
				borderColor: "var(--accent)",
				color: "var(--accent)"
			},
			onClick: () => {
				firedRef.current = false;
				startPairing();
			},
			children: t("whatsappqroverlay.TryAgain", { defaultValue: "Try again" })
		})]
	});
	if (status === "idle" || status === "disconnected") return (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-3 p-4 border border-border bg-bg-hover",
		children: [
			(0, import_jsx_runtime.jsx)("div", {
				className: "mb-2 text-xs text-muted",
				children: t("signalqroverlay.PairUsingSignalDesktop", { defaultValue: "Pair Signal by generating a provisioning QR code and scanning it from Signal Desktop." })
			}),
			error ? (0, import_jsx_runtime.jsx)("div", {
				className: "mb-2 text-xs text-danger",
				children: error
			}) : null,
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "text-xs-tight",
				style: {
					borderColor: "var(--accent)",
					color: "var(--accent)"
				},
				onClick: () => {
					firedRef.current = false;
					startPairing();
				},
				children: t("signalqroverlay.ConnectSignal", { defaultValue: "Connect Signal" })
			})
		]
	});
	return (0, import_jsx_runtime.jsx)("div", {
		className: "mt-3 p-4",
		style: {
			border: "1px solid rgba(255,255,255,0.08)",
			background: "rgba(255,255,255,0.04)"
		},
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-start gap-4",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "shrink-0",
				children: qrDataUrl ? (0, import_jsx_runtime.jsx)("img", {
					src: qrDataUrl,
					alt: "Signal QR Code",
					className: "h-48 w-48 bg-white dark:bg-white",
					style: {
						imageRendering: "pixelated",
						border: "1px solid var(--border)"
					}
				}) : (0, import_jsx_runtime.jsx)("div", {
					className: "flex h-48 w-48 items-center justify-center",
					style: {
						border: "1px solid var(--border)",
						background: "var(--bg-hover)"
					},
					children: (0, import_jsx_runtime.jsx)("span", {
						className: "animate-pulse text-xs text-muted",
						children: t("signalqroverlay.GeneratingQR", { defaultValue: "Generating QR…" })
					})
				})
			}), (0, import_jsx_runtime.jsxs)("div", {
				className: "min-w-0 flex-1",
				children: [
					(0, import_jsx_runtime.jsx)("div", {
						className: "mb-2 text-xs font-medium text-txt",
						children: t("signalqroverlay.ScanWithSignalDesktop", { defaultValue: "Scan with Signal Desktop" })
					}),
					(0, import_jsx_runtime.jsxs)("ol", {
						className: "m-0 list-decimal space-y-1 pl-4 text-xs-tight text-muted",
						children: [
							(0, import_jsx_runtime.jsx)("li", { children: t("signalqroverlay.OpenSignalDesktop", { defaultValue: "Open Signal Desktop on your Mac." }) }),
							(0, import_jsx_runtime.jsx)("li", { children: t("signalqroverlay.OpenLinkedDevices", { defaultValue: "Open Signal settings and choose Linked Devices." }) }),
							(0, import_jsx_runtime.jsx)("li", { children: t("signalqroverlay.ScanPrompt", { defaultValue: "Choose Link New Device and scan the QR code shown here." }) })
						]
					}),
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						className: "mt-3 text-2xs text-muted",
						onClick: () => void stopPairing(),
						children: t("common.cancel")
					})
				]
			})]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/connectors/TelegramAccountConnectorPanel.js
function accountLabel(status) {
	const account = status?.account;
	if (!account) return null;
	if (account.username) return `@${account.username}`;
	const parts = [account.firstName, account.lastName].filter(Boolean);
	if (parts.length > 0) return parts.join(" ");
	return account.phone;
}
function currentPrompt(status) {
	switch (status?.status) {
		case "waiting_for_provisioning_code": return {
			label: "Telegram app provisioning code",
			placeholder: "Code from Telegram after the my.telegram.org login prompt",
			field: "provisioningCode"
		};
		case "waiting_for_telegram_code": return {
			label: status.isCodeViaApp ? "Telegram app login code" : "Telegram SMS login code",
			placeholder: status.isCodeViaApp ? "Code delivered inside Telegram" : "SMS code delivered to your phone",
			field: "telegramCode"
		};
		case "waiting_for_password": return {
			label: "Telegram two-factor password",
			placeholder: "Telegram account password",
			field: "password"
		};
		default: return {
			label: "",
			placeholder: "",
			field: null
		};
	}
}
function TelegramAccountConnectorPanel() {
	const { t } = useApp();
	const [status, setStatus] = useState(null);
	const [phone, setPhone] = useState("");
	const [inputValue, setInputValue] = useState("");
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [disconnecting, setDisconnecting] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const [error, setError] = useState(null);
	const prompt = useMemo(() => currentPrompt(status), [status]);
	const refreshStatus = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const nextStatus = await client.getTelegramAccountStatus();
			setStatus(nextStatus);
			setPhone((current) => current || nextStatus.phone || "");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		refreshStatus();
		return client.onWsEvent("ws-reconnected", () => {
			refreshStatus();
		});
	}, [refreshStatus]);
	const startAuth = useCallback(async () => {
		const trimmedPhone = phone.trim();
		if (!trimmedPhone && !(status?.phone ?? "").trim()) {
			setError("Telegram phone number is required.");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const nextStatus = await client.startTelegramAccountAuth(trimmedPhone);
			setStatus(nextStatus);
			setPhone(nextStatus.phone ?? trimmedPhone);
			setInputValue("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setSubmitting(false);
		}
	}, [phone, status?.phone]);
	const submitAuthInput = useCallback(async () => {
		if (!prompt.field || !inputValue.trim()) return;
		setSubmitting(true);
		setError(null);
		try {
			const payload = prompt.field === "password" ? { password: inputValue } : { [prompt.field]: inputValue.trim() };
			setStatus(await client.submitTelegramAccountAuth(payload));
			setInputValue("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setSubmitting(false);
		}
	}, [inputValue, prompt.field]);
	const disconnect = useCallback(async () => {
		setDisconnecting(true);
		setError(null);
		try {
			setStatus(await client.disconnectTelegramAccount());
			setPhone("");
			setInputValue("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setDisconnecting(false);
		}
	}, []);
	const restartAgent = useCallback(async () => {
		setRestarting(true);
		setError(null);
		try {
			await client.restartAndWait();
			await refreshStatus();
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setRestarting(false);
		}
	}, [refreshStatus]);
	const connectedLabel = accountLabel(status);
	return (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
		tone: error || status?.status === "error" ? "danger" : "default",
		className: "mt-4",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "space-y-3 text-xs",
			children: [
				(0, import_jsx_runtime.jsx)("div", {
					className: "font-semibold text-txt",
					children: t("pluginsview.TelegramAccountSetupTitle", { defaultValue: "Connect your Telegram account" })
				}),
				(0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: t("pluginsview.TelegramAccountSetupHint", { defaultValue: "This is separate from the Telegram bot connector. The app logs into Telegram as you, saves a local session, and then the Telegram account connector comes online after the agent restarts." })
				}),
				loading ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: t("common.loading", { defaultValue: "Loading…" })
				}) : null,
				connectedLabel ? (0, import_jsx_runtime.jsx)("div", {
					className: "rounded-lg border border-border/40 bg-bg/60 px-3 py-2 text-xs-tight text-muted-strong",
					children: status?.serviceConnected ? `Connected as ${connectedLabel}.` : `Authenticated as ${connectedLabel}.`
				}) : null,
				status?.status === "idle" || status?.status === "error" ? (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-2",
					children: [(0, import_jsx_runtime.jsx)("input", {
						type: "tel",
						value: phone,
						onChange: (event) => {
							setPhone(event.target.value);
							if (error) setError(null);
						},
						placeholder: "+15551234567",
						className: "h-8 w-full rounded-lg border border-border/50 bg-bg/70 px-3 text-xs-tight text-txt placeholder:text-muted/50 focus:border-accent focus:outline-none"
					}), (0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
						onClick: () => {
							startAuth();
						},
						disabled: submitting,
						children: submitting ? t("common.connecting", { defaultValue: "Starting…" }) : t("common.connect", { defaultValue: "Connect" })
					})]
				}) : null,
				prompt.field ? (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-2",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "text-muted",
						children: prompt.label
					}), (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)("input", {
							type: prompt.field === "password" ? "password" : "text",
							value: inputValue,
							onChange: (event) => {
								setInputValue(event.target.value);
								if (error) setError(null);
							},
							placeholder: prompt.placeholder,
							className: "h-8 flex-1 rounded-lg border border-border/50 bg-bg/70 px-3 text-xs-tight text-txt placeholder:text-muted/50 focus:border-accent focus:outline-none",
							onKeyDown: (event) => {
								if (event.key === "Enter") submitAuthInput();
							}
						}), (0, import_jsx_runtime.jsx)(Button, {
							variant: "default",
							size: "sm",
							className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
							onClick: () => {
								submitAuthInput();
							},
							disabled: submitting || !inputValue.trim(),
							children: submitting ? t("common.submitting", { defaultValue: "Submitting…" }) : t("common.continue", { defaultValue: "Continue" })
						})]
					})]
				}) : null,
				status?.restartRequired ? (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-2 rounded-lg border border-border/40 bg-bg/60 px-3 py-2 text-xs-tight text-muted-strong",
					children: [(0, import_jsx_runtime.jsx)("div", { children: t("pluginsview.TelegramAccountRestartHint", { defaultValue: "Telegram authentication is saved locally. Restart the agent to bring the connector online." }) }), (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
						onClick: () => {
							restartAgent();
						},
						disabled: restarting,
						children: restarting ? t("common.restarting", { defaultValue: "Restarting…" }) : t("common.restart", { defaultValue: "Restart agent" })
					})]
				}) : null,
				status?.status !== "idle" ? (0, import_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
					onClick: () => {
						disconnect();
					},
					disabled: disconnecting,
					children: disconnecting ? t("common.disconnecting", { defaultValue: "Disconnecting…" }) : t("common.disconnect", { defaultValue: "Disconnect" })
				}) : null,
				status?.status === "waiting_for_provisioning_code" ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: t("pluginsview.TelegramAccountProvisioningExplain", { defaultValue: "Telegram first asks the app to provision credentials through my.telegram.org. Enter the code Telegram sent you there, then the app will request the normal account login code." })
				}) : null,
				status?.status === "waiting_for_telegram_code" ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: status.isCodeViaApp ? "Enter the login code that Telegram sent inside your Telegram app." : "Enter the login code that Telegram sent by SMS."
				}) : null,
				status?.status === "waiting_for_password" ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: "Enter your Telegram two-factor password to finish linking this account."
				}) : null,
				error || status?.error ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-danger",
					children: error ?? status?.error
				}) : null
			]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/connectors/TelegramBotSetupPanel.js
function TelegramBotSetupPanel() {
	const { t } = useApp();
	const [status, setStatus] = useState("idle");
	const [token, setToken] = useState("");
	const [botInfo, setBotInfo] = useState(null);
	const [error, setError] = useState(null);
	const validateAndSave = useCallback(async () => {
		const trimmed = token.trim();
		if (!trimmed) {
			setError("Please paste your bot token");
			return;
		}
		setStatus("validating");
		setError(null);
		try {
			const res = await client.fetch("/api/telegram-setup/validate-token", {
				method: "POST",
				body: JSON.stringify({ token: trimmed })
			});
			if (res.ok && res.bot) {
				setBotInfo(res.bot);
				setStatus("connected");
				setToken("");
			} else {
				setError(res.error ?? "Invalid bot token");
				setStatus("error");
			}
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
			setStatus("error");
		}
	}, [token]);
	const disconnect = useCallback(async () => {
		try {
			await client.fetch("/api/telegram-setup/disconnect", { method: "POST" });
			setBotInfo(null);
			setStatus("idle");
		} catch {}
	}, []);
	if (status === "connected" && botInfo) return (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
		tone: "accent",
		className: "mt-4",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "space-y-2 text-xs",
			children: [
				(0, import_jsx_runtime.jsxs)("div", {
					className: "font-semibold text-txt",
					children: [
						t("pluginsview.TelegramConnected", { defaultValue: "Telegram bot connected" }),
						" — ",
						(0, import_jsx_runtime.jsxs)("span", {
							className: "text-muted-strong",
							children: ["@", botInfo.username]
						})
					]
				}),
				(0, import_jsx_runtime.jsx)("div", {
					className: "text-muted",
					children: t("pluginsview.TelegramConnectedHint", { defaultValue: "Your bot is saved and will auto-connect on next start. Enable the Telegram plugin above if it isn't already active." })
				}),
				(0, import_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
					onClick: () => {
						disconnect();
					},
					children: t("common.disconnect", { defaultValue: "Disconnect" })
				})
			]
		})
	});
	return (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
		tone: status === "error" ? "danger" : "default",
		className: "mt-4",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "space-y-3 text-xs",
			children: [
				(0, import_jsx_runtime.jsx)("div", {
					className: "font-semibold text-txt",
					children: t("pluginsview.TelegramSetupTitle", { defaultValue: "Connect a Telegram Bot" })
				}),
				(0, import_jsx_runtime.jsxs)("ol", {
					className: "list-inside list-decimal space-y-1 text-muted",
					children: [
						(0, import_jsx_runtime.jsxs)("li", { children: [
							t("common.open", { defaultValue: "Open " }),
							(0, import_jsx_runtime.jsx)("a", {
								href: "https://t.me/BotFather",
								target: "_blank",
								rel: "noopener noreferrer",
								className: "font-medium text-accent underline",
								children: "@BotFather"
							}),
							t("pluginsview.TelegramStep1b", { defaultValue: " on Telegram" })
						] }),
						(0, import_jsx_runtime.jsx)("li", { children: t("pluginsview.TelegramStep2", { defaultValue: "Send /newbot and follow the prompts to create your bot" }) }),
						(0, import_jsx_runtime.jsx)("li", { children: t("pluginsview.TelegramStep3", { defaultValue: "Copy the bot token and paste it below" }) })
					]
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2",
					children: [(0, import_jsx_runtime.jsx)("input", {
						type: "password",
						value: token,
						onChange: (e) => {
							setToken(e.target.value);
							if (status === "error") setStatus("idle");
						},
						placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
						className: "h-8 flex-1 rounded-lg border border-border/50 bg-bg/70 px-3 text-xs-tight text-txt placeholder:text-muted/50 focus:border-accent focus:outline-none",
						onKeyDown: (e) => {
							if (e.key === "Enter") validateAndSave();
						}
					}), (0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "h-8 rounded-xl px-4 text-xs-tight font-semibold",
						onClick: () => {
							validateAndSave();
						},
						disabled: status === "validating" || !token.trim(),
						children: status === "validating" ? t("common.validating", { defaultValue: "Validating…" }) : t("common.connect", { defaultValue: "Connect" })
					})]
				}),
				error ? (0, import_jsx_runtime.jsx)("div", {
					className: "text-danger",
					children: error
				}) : null
			]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/connectors/WhatsAppQrOverlay.js
function WhatsAppQrOverlay({ accountId = "default", onConnected, connectedMessage }) {
	const { status, qrDataUrl, phoneNumber, error, startPairing, stopPairing, disconnect } = useWhatsAppPairing(accountId);
	const { t } = useApp();
	const firedRef = useRef(false);
	useEffect(() => {
		if (status === "connected" && onConnected && !firedRef.current) {
			firedRef.current = true;
			const timer = setTimeout(onConnected, 1200);
			return () => clearTimeout(timer);
		}
	}, [status, onConnected]);
	if (status === "connected") return (0, import_jsx_runtime.jsxs)("div", {
		className: "p-4 mt-3 border border-ok bg-[var(--ok-subtle)]",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2",
				children: [(0, import_jsx_runtime.jsx)("span", { className: "inline-block w-2 h-2 rounded-full bg-ok" }), (0, import_jsx_runtime.jsxs)("span", {
					className: "text-xs font-medium text-ok",
					children: [t("common.connected"), phoneNumber ? ` (+${phoneNumber})` : ""]
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "text-2xs mt-1 text-muted",
				children: connectedMessage ?? (onConnected ? "Finishing WhatsApp setup..." : "WhatsApp is paired. Auth state is saved for automatic reconnection.")
			}),
			!onConnected && (0, import_jsx_runtime.jsx)(Button, {
				variant: "destructive",
				size: "sm",
				className: "mt-2 text-2xs",
				onClick: () => void disconnect(),
				children: t("common.disconnect")
			})
		]
	});
	if (status === "error" || status === "timeout") return (0, import_jsx_runtime.jsxs)("div", {
		className: "p-4 mt-3 border border-danger bg-[var(--destructive-subtle)]",
		children: [(0, import_jsx_runtime.jsx)("div", {
			className: "text-xs mb-2 text-danger",
			children: status === "timeout" ? "QR code expired. Please try again." : error ?? "An error occurred."
		}), (0, import_jsx_runtime.jsx)(Button, {
			variant: "outline",
			size: "sm",
			className: "text-xs-tight",
			style: {
				borderColor: "var(--accent)",
				color: "var(--accent)"
			},
			onClick: () => {
				firedRef.current = false;
				startPairing();
			},
			children: t("whatsappqroverlay.TryAgain")
		})]
	});
	if (status === "idle" || status === "disconnected") return (0, import_jsx_runtime.jsxs)("div", {
		className: "p-4 mt-3 border border-border bg-bg-hover",
		children: [
			(0, import_jsx_runtime.jsx)("div", {
				className: "text-xs mb-2 text-muted",
				children: t("whatsappqroverlay.ScanAQRCodeWith")
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "text-2xs mb-2 opacity-70 text-muted",
				children: t("whatsappqroverlay.UsesAnUnofficialW")
			}),
			(0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "text-xs-tight",
				style: {
					borderColor: "var(--accent)",
					color: "var(--accent)"
				},
				onClick: () => {
					firedRef.current = false;
					startPairing();
				},
				children: t("whatsappqroverlay.ConnectWhatsApp")
			})
		]
	});
	return (0, import_jsx_runtime.jsx)("div", {
		className: "p-4 mt-3",
		style: {
			border: "1px solid rgba(255,255,255,0.08)",
			background: "rgba(255,255,255,0.04)"
		},
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col items-start gap-4 sm:flex-row",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "shrink-0",
				children: qrDataUrl ? (0, import_jsx_runtime.jsx)("img", {
					src: qrDataUrl,
					alt: "WhatsApp QR Code",
					className: "h-40 w-40 bg-white dark:bg-white sm:h-48 sm:w-48",
					style: {
						imageRendering: "pixelated",
						border: "1px solid var(--border)"
					}
				}) : (0, import_jsx_runtime.jsx)("div", {
					className: "flex h-40 w-40 items-center justify-center sm:h-48 sm:w-48",
					style: {
						border: "1px solid var(--border)",
						background: "var(--bg-hover)"
					},
					children: (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs animate-pulse text-muted",
						children: t("whatsappqroverlay.GeneratingQR")
					})
				})
			}), (0, import_jsx_runtime.jsxs)("div", {
				className: "flex-1 min-w-0",
				children: [
					(0, import_jsx_runtime.jsx)("div", {
						className: "text-xs font-medium mb-2 text-txt",
						children: t("whatsappqroverlay.ScanWithWhatsApp")
					}),
					(0, import_jsx_runtime.jsxs)("ol", {
						className: "text-xs-tight space-y-1 list-decimal pl-4 m-0 text-muted",
						children: [
							(0, import_jsx_runtime.jsx)("li", { children: t("whatsappqroverlay.OpenWhatsAppOnYou") }),
							(0, import_jsx_runtime.jsxs)("li", { children: [
								t("whatsappqroverlay.Tap"),
								" ",
								(0, import_jsx_runtime.jsx)("strong", { children: t("whatsappqroverlay.Menu") }),
								" or",
								" ",
								(0, import_jsx_runtime.jsx)("strong", { children: t("nav.settings") }),
								" ",
								t("whatsappqroverlay.andSelect"),
								" ",
								(0, import_jsx_runtime.jsx)("strong", { children: t("whatsappqroverlay.LinkedDevices") })
							] }),
							(0, import_jsx_runtime.jsxs)("li", { children: [
								t("whatsappqroverlay.Tap"),
								" ",
								(0, import_jsx_runtime.jsx)("strong", { children: t("whatsappqroverlay.LinkADevice") })
							] }),
							(0, import_jsx_runtime.jsx)("li", { children: t("whatsappqroverlay.PointYourPhoneAt") })
						]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "mt-3 flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)("span", {
							className: "inline-block w-1.5 h-1.5 rounded-full animate-pulse",
							style: { background: "var(--accent)" }
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "text-2xs text-muted",
							children: t("whatsappqroverlay.QRRefreshesAutomat")
						})]
					}),
					(0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						className: "mt-3 text-2xs text-muted",
						onClick: () => void stopPairing(),
						children: t("common.cancel")
					})
				]
			})]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/connectors/ConnectorSetupPanel.js
function normalizePluginId(pluginId) {
	return pluginId.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}
const connectorSetupRegistry = /* @__PURE__ */ new Map();
/**
* Register a custom connector setup panel component for a given connector ID.
* The connectorId is normalized (lowercased, non-alphanumeric stripped) before
* storage, so callers can pass raw plugin IDs.
*/
function registerConnectorSetupPanel(connectorId, component) {
	connectorSetupRegistry.set(normalizePluginId(connectorId), component);
}
function hasConnectorSetupPanel(pluginId) {
	const normalized = normalizePluginId(pluginId);
	if (connectorSetupRegistry.has(normalized)) return true;
	if (normalized.includes("lifeopsbrowser") || normalized.includes("browserbridg")) return Boolean(getBootConfig().lifeOpsBrowserSetupPanel);
	if (normalized.includes("telegramaccount")) return true;
	if (normalized.includes("plugintelegram")) return true;
	switch (normalized) {
		case "whatsapp":
		case "signal":
		case "discordlocal":
		case "bluebubbles":
		case "imessage":
		case "telegram": return true;
		default: return false;
	}
}
function ConnectorSetupPanel({ pluginId }) {
	const normalized = normalizePluginId(pluginId);
	const RegisteredPanel = connectorSetupRegistry.get(normalized);
	if (RegisteredPanel) return (0, import_jsx_runtime.jsx)(RegisteredPanel, {});
	if (normalized.includes("lifeopsbrowser") || normalized.includes("browserbridg")) {
		const BrowserBridgeSetupPanel = getBootConfig().lifeOpsBrowserSetupPanel;
		return BrowserBridgeSetupPanel ? (0, import_jsx_runtime.jsx)(BrowserBridgeSetupPanel, {}) : null;
	}
	if (normalized.includes("telegramaccount")) return (0, import_jsx_runtime.jsx)(TelegramAccountConnectorPanel, {});
	if (normalized.includes("plugintelegram")) return (0, import_jsx_runtime.jsx)(TelegramBotSetupPanel, {});
	switch (normalized) {
		case "whatsapp": return (0, import_jsx_runtime.jsx)(WhatsAppQrOverlay, { accountId: "default" });
		case "signal": return (0, import_jsx_runtime.jsx)(SignalQrOverlay, { accountId: "default" });
		case "discordlocal": return (0, import_jsx_runtime.jsx)(DiscordLocalConnectorPanel, {});
		case "bluebubbles": return (0, import_jsx_runtime.jsx)(BlueBubblesStatusPanel, {});
		case "imessage": return (0, import_jsx_runtime.jsx)(IMessageStatusPanel, {});
		case "telegram": return (0, import_jsx_runtime.jsx)(TelegramBotSetupPanel, {});
		default: return null;
	}
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/PluginConfigForm.js
/**
* Hook that manages the "allow all / specific chats" toggle state.
* Mode is explicit (not derived from field value) so clearing the field
* doesn't flip the toggle. Returns the mode, a toggle handler, and
* hiddenKeys for PluginConfigForm.
*/
function useTelegramChatMode(plugin, pluginConfigs, onParamChange) {
	const localValue = pluginConfigs.telegram?.TELEGRAM_ALLOWED_CHATS;
	const serverValue = plugin.parameters?.find((p) => p.key === "TELEGRAM_ALLOWED_CHATS")?.currentValue ?? "";
	const currentValue = localValue ?? serverValue;
	const [allowAll, setAllowAll] = useState(() => !currentValue.trim());
	const stashedChats = useRef(currentValue);
	if (currentValue.trim()) stashedChats.current = currentValue;
	return {
		allowAll,
		toggle: useCallback((next) => {
			setAllowAll(next);
			if (next) onParamChange("telegram", "TELEGRAM_ALLOWED_CHATS", "");
			else onParamChange("telegram", "TELEGRAM_ALLOWED_CHATS", stashedChats.current?.trim() || "[]");
		}, [onParamChange]),
		hiddenKeys: allowAll ? TELEGRAM_ALLOW_ALL_HIDDEN : void 0
	};
}
function TelegramChatModeToggle({ allowAll, onToggle }) {
	const { t } = useApp();
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center justify-between rounded-lg border border-border bg-[var(--card,rgba(255,255,255,0.03))] px-4 py-3 mb-4",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col gap-0.5",
			children: [(0, import_jsx_runtime.jsx)("span", {
				className: "text-sm font-semibold text-txt",
				children: allowAll ? t("pluginsview.AllowAllChats", { defaultValue: "Allow all chats" }) : t("pluginsview.AllowSpecificChatsOnly", { defaultValue: "Allow only specific chats" })
			}), (0, import_jsx_runtime.jsx)("span", {
				className: "text-xs-tight text-muted",
				children: allowAll ? t("pluginsview.BotRespondsAnyChat", { defaultValue: "Bot will respond in any chat" }) : t("pluginsview.BotRespondsListedChatIds", { defaultValue: "Bot will only respond in listed chat IDs" })
			})]
		}), (0, import_jsx_runtime.jsx)(Switch, {
			checked: allowAll,
			onCheckedChange: onToggle
		})]
	});
}
/** Wraps PluginConfigForm with the Telegram chat mode toggle + hidden keys. */
function TelegramPluginConfig({ plugin, pluginConfigs, onParamChange }) {
	const { allowAll, toggle, hiddenKeys } = useTelegramChatMode(plugin, pluginConfigs, onParamChange);
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(TelegramChatModeToggle, {
		allowAll,
		onToggle: toggle
	}), (0, import_jsx_runtime.jsx)(PluginConfigForm, {
		plugin,
		pluginConfigs,
		onParamChange,
		hiddenKeys
	})] });
}
function PluginConfigForm({ plugin, pluginConfigs, onParamChange, hiddenKeys }) {
	const params = plugin.parameters ?? [];
	const { schema, hints: autoHints } = useMemo(() => paramsToSchema(params, plugin.id), [params, plugin.id]);
	const hints = useMemo(() => {
		const merged = { ...autoHints };
		const serverHints = plugin.configUiHints;
		if (serverHints) for (const [key, serverHint] of Object.entries(serverHints)) merged[key] = {
			...merged[key],
			...serverHint
		};
		if (hiddenKeys) for (const key of hiddenKeys) merged[key] = {
			...merged[key],
			hidden: true
		};
		return merged;
	}, [
		autoHints,
		plugin.configUiHints,
		hiddenKeys
	]);
	const values = useMemo(() => {
		const v = {};
		const props = schema.properties ?? {};
		for (const p of params) {
			const isArrayField = props[p.key]?.type === "array";
			const configValue = pluginConfigs[plugin.id]?.[p.key];
			if (configValue !== void 0) if (isArrayField && typeof configValue === "string") v[p.key] = configValue ? configValue.split(",").map((s) => s.trim()).filter(Boolean) : [];
			else v[p.key] = configValue;
			else if (p.isSet && !p.sensitive && p.currentValue != null) if (isArrayField && typeof p.currentValue === "string") v[p.key] = String(p.currentValue) ? String(p.currentValue).split(",").map((s) => s.trim()).filter(Boolean) : [];
			else v[p.key] = p.currentValue;
		}
		return v;
	}, [
		params,
		plugin.id,
		pluginConfigs,
		schema
	]);
	const setKeys = useMemo(() => new Set(params.filter((p) => p.isSet).map((p) => p.key)), [params]);
	const handleChange = useCallback((key, value) => {
		const stringValue = Array.isArray(value) ? value.join(", ") : String(value ?? "");
		onParamChange(plugin.id, key, stringValue);
	}, [plugin.id, onParamChange]);
	return (0, import_jsx_runtime.jsx)(ConfigRenderer, {
		schema,
		hints,
		values,
		setKeys,
		registry: defaultRegistry,
		pluginId: plugin.id,
		onChange: handleChange
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/plugin-view-connectors.js
const CLOUD_OAUTH_CONNECTORS = {
	slack: {
		platform: "slack",
		connectionRole: "agent",
		buttonLabel: "Use Slack OAuth",
		connectedHint: "Connect Slack with Eliza Cloud OAuth. Cloud stores the workspace token and the Slack plugin remains the runtime surface for messages and actions.",
		disconnectedHint: "Connect Eliza Cloud first to use Slack OAuth instead of local Socket Mode tokens.",
		successNotice: "Finish Slack OAuth in your browser, then return here."
	},
	twitter: {
		platform: "twitter",
		connectionRole: "agent",
		buttonLabel: "Use X/Twitter OAuth",
		connectedHint: "Connect X/Twitter with Eliza Cloud OAuth so agent posts, mentions, replies, and DMs use the plugin through cloud-held tokens.",
		disconnectedHint: "Connect Eliza Cloud first to use X/Twitter OAuth instead of local developer tokens.",
		successNotice: "Finish X/Twitter OAuth in your browser, then return here."
	}
};
function getCloudOAuthConnector(pluginId, selectedMode) {
	if (selectedMode !== "oauth") return null;
	return CLOUD_OAUTH_CONNECTORS[pluginId] ?? null;
}
function groupVisiblePlugins(visiblePlugins) {
	const groupMap = /* @__PURE__ */ new Map();
	const groupOrder = [];
	for (const plugin of visiblePlugins) {
		const subgroupId = subgroupForPlugin(plugin);
		if (!groupMap.has(subgroupId)) {
			groupMap.set(subgroupId, []);
			groupOrder.push(subgroupId);
		}
		groupMap.get(subgroupId)?.push(plugin);
	}
	return groupOrder.flatMap((subgroupId) => {
		const plugins = groupMap.get(subgroupId);
		if (!plugins) return [];
		return [{
			id: subgroupId,
			label: SUBGROUP_LABELS[subgroupId] ?? subgroupId,
			plugins
		}];
	});
}
function ConnectorPluginCard({ collapseLabel, connectorExpandedIds, connectorInstallPrompt, connectorSelectedId, expandLabel, formatSaveSettingsLabel, formatTestConnectionLabel, handleConfigReset, handleConfigSave, handleConnectorExpandedChange, handleConnectorSectionToggle, handleInstallPlugin, handleOpenPluginExternalUrl, handleParamChange, handleTestConnection, handleTogglePlugin, hasPluginToggleInFlight, installPluginLabel, installProgress, installingPlugins, installProgressLabel, loadFailedLabel, needsSetupLabel, noConfigurationNeededLabel, notInstalledLabel, plugin, pluginConfigs, pluginDescriptionFallback, pluginSaveSuccess, pluginSaving, readyLabel, registerConnectorContentItem, renderResolvedIcon, t, testResults, togglingPlugins }) {
	const { elizaCloudConnected, setActionNotice, setState, setTab } = useApp();
	const connectorMode = useConnectorMode(plugin.id, { elizaCloudConnected });
	const [managedDiscordBusy, setManagedDiscordBusy] = useState(false);
	const [cloudOAuthBusy, setCloudOAuthBusy] = useState(false);
	const [managedDiscordAgents, setManagedDiscordAgents] = useState([]);
	const [managedDiscordPickerOpen, setManagedDiscordPickerOpen] = useState(false);
	const [managedDiscordSelectedAgentId, setManagedDiscordSelectedAgentId] = useState(null);
	const selectedCloudOAuthConnector = getCloudOAuthConnector(plugin.id, connectorMode.selectedMode);
	const cloudOAuthConnector = selectedCloudOAuthConnector ?? (!elizaCloudConnected ? CLOUD_OAUTH_CONNECTORS[plugin.id] ?? null : null);
	const isCloudOAuthMode = Boolean(selectedCloudOAuthConnector);
	const isDiscordManagedMode = plugin.id === "discord" && connectorMode.selectedMode === "managed";
	const showTelegramCloudGatewayNotice = plugin.id === "telegram" && connectorMode.selectedMode === "cloud-bot" || !elizaCloudConnected && plugin.id === "telegram";
	const cloudBackedConnectorMode = elizaCloudConnected && (isCloudOAuthMode || isDiscordManagedMode);
	const hasParams = (plugin.parameters?.length ?? 0) > 0 && plugin.id !== "__ui-showcase__";
	const isExpanded = connectorExpandedIds.has(plugin.id);
	const isSelected = connectorSelectedId === plugin.id;
	const requiredParams = hasParams ? plugin.parameters.filter((param) => param.required) : [];
	const requiredSetCount = requiredParams.filter((param) => param.isSet).length;
	const setCount = hasParams ? plugin.parameters.filter((param) => param.isSet).length : 0;
	const totalCount = hasParams ? plugin.parameters.length : 0;
	const allParamsSet = cloudBackedConnectorMode || !hasParams || requiredSetCount === requiredParams.length;
	const isToggleBusy = togglingPlugins.has(plugin.id);
	const toggleDisabled = isToggleBusy || hasPluginToggleInFlight && !isToggleBusy;
	const isSaving = pluginSaving.has(plugin.id);
	const saveSuccess = pluginSaveSuccess.has(plugin.id);
	const testResult = testResults.get(plugin.id);
	const notLoadedLabel = t("pluginsview.NotLoaded", { defaultValue: "Not loaded" });
	const isStoreInstallMissing = plugin.source === "store" && plugin.enabled && !plugin.isActive && Boolean(plugin.npmName);
	const inactiveLabel = plugin.loadError ? loadFailedLabel : plugin.source === "store" ? notInstalledLabel : notLoadedLabel;
	const pluginLinks = getPluginResourceLinks(plugin, { draftConfig: pluginConfigs[plugin.id] });
	const openCloudAgentsView = () => {
		setState("cloudDashboardView", "overview");
		setTab("settings");
	};
	const ensureManagedDiscordGatewayProvisioned = async (agent) => {
		if (agent.status === "running") return false;
		const provisionResponse = await client.provisionCloudCompatAgent(agent.agent_id);
		if (!provisionResponse.success) throw new Error(provisionResponse.error || t("pluginsview.ManagedDiscordGatewayProvisionFailed", { defaultValue: "Failed to start the shared Discord gateway in Eliza Cloud." }));
		return provisionResponse.data?.status !== "running";
	};
	const startManagedDiscordOauth = async (agent, options) => {
		await handleOpenPluginExternalUrl((await client.createCloudCompatAgentManagedDiscordOauth(agent.agent_id, {
			returnUrl: typeof window !== "undefined" ? buildManagedDiscordSettingsReturnUrl(window.location.href) ?? void 0 : void 0,
			botNickname: agent.agent_name?.trim() || void 0
		})).data.authorizeUrl);
		setManagedDiscordPickerOpen(false);
		setActionNotice(t("elizaclouddashboard.DiscordSetupContinuesInBrowser", { defaultValue: options?.gatewayDeploying ? "Finish Discord setup in your browser, then wait for the shared Discord gateway to finish deploying." : "Finish Discord setup in your browser, then return here." }), "info", 5e3);
	};
	const handleOpenManagedDiscord = async () => {
		if (managedDiscordBusy) return;
		if (!elizaCloudConnected) {
			setState("cloudDashboardView", "billing");
			setTab("settings");
			setActionNotice(t("pluginsview.ManagedDiscordRequiresCloud", { defaultValue: "Connect Eliza Cloud first, then you can use managed Discord OAuth." }), "info", 5e3);
			return;
		}
		setManagedDiscordBusy(true);
		try {
			const response = await client.getCloudCompatAgents();
			const agents = Array.isArray(response.data) ? response.data : [];
			const choice = resolveManagedDiscordAgentChoice(agents);
			if (choice.mode === "none" || choice.mode === "bootstrap") {
				const gatewayResponse = await client.ensureCloudCompatManagedDiscordAgent();
				const gatewayAgent = gatewayResponse.data.agent;
				const gatewayDeploying = await ensureManagedDiscordGatewayProvisioned(gatewayAgent);
				setManagedDiscordAgents([gatewayAgent]);
				setManagedDiscordSelectedAgentId(gatewayAgent.agent_id);
				setManagedDiscordPickerOpen(false);
				setActionNotice(t("pluginsview.ManagedDiscordGatewayCreated", { defaultValue: gatewayResponse.data.created ? "Created a shared Discord gateway agent. Continue in your browser and choose a server you own." : "Using your shared Discord gateway agent. Continue in your browser and choose a server you own." }), "info", 5200);
				await startManagedDiscordOauth(gatewayAgent, { gatewayDeploying });
				return;
			}
			if (choice.mode === "picker") {
				setManagedDiscordAgents(agents);
				setManagedDiscordSelectedAgentId(choice.selectedAgentId);
				setManagedDiscordPickerOpen(true);
				setActionNotice(t("pluginsview.ManagedDiscordChooseTarget", { defaultValue: "Choose which cloud agent should receive managed Discord for this owned server, then continue." }), "info", 4200);
				return;
			}
			const gatewayDeploying = await ensureManagedDiscordGatewayProvisioned(choice.agent);
			await startManagedDiscordOauth(choice.agent, { gatewayDeploying });
		} catch (error) {
			openCloudAgentsView();
			setActionNotice(error instanceof Error ? error.message : t("elizaclouddashboard.DiscordSetupFailed", { defaultValue: "Failed to start Discord setup." }), "error", 4200);
		} finally {
			setManagedDiscordBusy(false);
		}
	};
	const handleConfirmManagedDiscordAgent = async () => {
		if (managedDiscordBusy || !managedDiscordSelectedAgentId) return;
		const agent = managedDiscordAgents.find((candidate) => candidate.agent_id === managedDiscordSelectedAgentId);
		if (!agent) {
			setActionNotice(t("pluginsview.ManagedDiscordChooseTarget", { defaultValue: "Choose which cloud agent should receive managed Discord for this owned server, then continue." }), "error", 4200);
			return;
		}
		setManagedDiscordBusy(true);
		try {
			await startManagedDiscordOauth(agent, { gatewayDeploying: await ensureManagedDiscordGatewayProvisioned(agent) });
		} catch (error) {
			openCloudAgentsView();
			setActionNotice(error instanceof Error ? error.message : t("elizaclouddashboard.DiscordSetupFailed", { defaultValue: "Failed to start Discord setup." }), "error", 4200);
		} finally {
			setManagedDiscordBusy(false);
		}
	};
	const handleOpenCloudOAuthConnector = async () => {
		if (!cloudOAuthConnector || cloudOAuthBusy) return;
		if (!elizaCloudConnected) {
			setState("cloudDashboardView", "billing");
			setTab("settings");
			setActionNotice(t("pluginsview.CloudOauthRequiresCloud", { defaultValue: "Connect Eliza Cloud first, then you can use OAuth for this connector." }), "info", 5e3);
			return;
		}
		setCloudOAuthBusy(true);
		try {
			const redirectUrl = typeof window !== "undefined" ? window.location.href : void 0;
			await handleOpenPluginExternalUrl((cloudOAuthConnector.platform === "twitter" ? await client.initiateCloudTwitterOauth({
				redirectUrl,
				connectionRole: cloudOAuthConnector.connectionRole
			}) : await client.initiateCloudOauth(cloudOAuthConnector.platform, {
				redirectUrl,
				connectionRole: cloudOAuthConnector.connectionRole
			})).authUrl);
			setActionNotice(cloudOAuthConnector.successNotice, "info", 5e3);
		} catch (error) {
			setActionNotice(error instanceof Error ? error.message : t("pluginsview.CloudOauthSetupFailed", { defaultValue: "Failed to start OAuth setup." }), "error", 4200);
		} finally {
			setCloudOAuthBusy(false);
		}
	};
	const BrandIcon = getBrandIcon(plugin.id);
	const connectorHeaderMedia = (0, import_jsx_runtime.jsx)("span", {
		className: `mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-xl)] border p-2.5 ${isSelected ? "border-accent/30 bg-accent/18 text-txt-strong" : "border-border/50 bg-bg-accent/80 text-muted"}`,
		children: BrandIcon ? (0, import_jsx_runtime.jsx)(BrandIcon, { className: "h-5 w-5 shrink-0" }) : renderResolvedIcon(plugin, {
			className: "h-4 w-4 shrink-0 rounded-[var(--radius-sm)] object-contain",
			emojiClassName: "text-base"
		})
	});
	const connectorHeaderHeading = (0, import_jsx_runtime.jsxs)("div", {
		className: "min-w-0",
		children: [(0, import_jsx_runtime.jsxs)("span", {
			"data-testid": `connector-header-${plugin.id}`,
			className: "flex min-w-0 flex-wrap items-center gap-2",
			children: [(0, import_jsx_runtime.jsx)("span", {
				className: "whitespace-normal break-words [overflow-wrap:anywhere] text-sm font-semibold leading-snug text-txt",
				children: plugin.name
			}), hasParams ? (0, import_jsx_runtime.jsxs)("span", {
				className: "text-xs-tight font-medium text-muted",
				children: [
					setCount,
					"/",
					totalCount,
					" ",
					t("common.configured")
				]
			}) : (0, import_jsx_runtime.jsx)("span", {
				className: "text-xs-tight font-medium text-muted",
				children: noConfigurationNeededLabel
			})]
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "mt-2",
			children: [(0, import_jsx_runtime.jsx)("p", {
				className: "text-sm text-muted",
				children: plugin.description || pluginDescriptionFallback
			}), plugin.enabled && !plugin.isActive && (0, import_jsx_runtime.jsx)("span", {
				className: "mt-1.5 flex flex-wrap items-center gap-2 text-xs-tight text-muted",
				children: (0, import_jsx_runtime.jsx)(StatusBadge, {
					label: inactiveLabel,
					tone: plugin.loadError ? "danger" : "warning"
				})
			})]
		})]
	});
	const statusLabel = allParamsSet ? readyLabel : needsSetupLabel;
	const StatusIcon = allParamsSet ? CheckCircle2 : AlertCircle;
	const connectorHeaderActions = (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		(0, import_jsx_runtime.jsx)("span", {
			role: "img",
			"aria-label": statusLabel,
			title: statusLabel,
			className: `inline-flex items-center ${allParamsSet ? "text-ok" : "text-warn"}`,
			children: (0, import_jsx_runtime.jsx)(StatusIcon, {
				className: "h-5 w-5",
				"aria-hidden": "true"
			})
		}),
		(0, import_jsx_runtime.jsx)(Switch, {
			checked: plugin.enabled,
			disabled: toggleDisabled,
			onClick: (event) => event.stopPropagation(),
			onKeyDown: (event) => event.stopPropagation(),
			onCheckedChange: (checked) => {
				handleTogglePlugin(plugin.id, checked);
			},
			"aria-label": `${plugin.enabled ? t("common.off") : t("common.on")} ${plugin.name}`
		}),
		(0, import_jsx_runtime.jsx)(Button, {
			variant: "ghost",
			size: "icon",
			className: `h-8 w-8 shrink-0 rounded-none border-0 bg-transparent transition-colors hover:bg-transparent ${isExpanded ? "text-txt" : "text-muted hover:text-txt"}`,
			onClick: (event) => {
				event?.stopPropagation();
				handleConnectorSectionToggle(plugin.id);
			},
			"aria-expanded": isExpanded,
			"aria-label": `${isExpanded ? collapseLabel : expandLabel} ${plugin.name}`,
			title: isExpanded ? collapseLabel : expandLabel,
			children: (0, import_jsx_runtime.jsx)(ChevronRight, { className: `h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}` })
		})
	] });
	const setupPanelPluginId = connectorMode.setupPluginId ?? plugin.id;
	const connectorSetupPanel = setupPanelPluginId ? (0, import_jsx_runtime.jsx)(ConnectorSetupPanel, { pluginId: setupPanelPluginId }) : null;
	const supportsConnectorSetupPanel = Boolean(setupPanelPluginId) && hasConnectorSetupPanel(setupPanelPluginId);
	const showPluginConfig = hasParams && setupPanelPluginId === plugin.id && !isDiscordManagedMode && !isCloudOAuthMode;
	return (0, import_jsx_runtime.jsx)("div", {
		"data-testid": `connector-section-${plugin.id}`,
		children: (0, import_jsx_runtime.jsxs)(PagePanel.CollapsibleSection, {
			ref: registerConnectorContentItem(plugin.id),
			variant: "section",
			"data-testid": `connector-card-${plugin.id}`,
			expanded: isExpanded,
			expandOnCollapsedSurfaceClick: true,
			className: `border-transparent transition-all ${isSelected ? "shadow-[0_18px_40px_rgba(3,5,10,0.16)]" : ""}`,
			onExpandedChange: (nextExpanded) => handleConnectorExpandedChange(plugin.id, nextExpanded),
			media: connectorHeaderMedia,
			heading: connectorHeaderHeading,
			headingClassName: "w-full text-inherit",
			actions: connectorHeaderActions,
			children: [
				connectorMode.modes.length > 1 && (0, import_jsx_runtime.jsx)(ConnectorModeSelector, {
					connectorId: plugin.id,
					selectedMode: connectorMode.selectedMode,
					onModeChange: connectorMode.setSelectedMode,
					elizaCloudConnected
				}),
				plugin.id === "discord" && (!elizaCloudConnected || connectorMode.selectedMode === "managed") && (0, import_jsx_runtime.jsxs)(PagePanel.Notice, {
					tone: "default",
					className: "mb-4",
					actions: (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold",
						onClick: () => {
							handleOpenManagedDiscord();
						},
						disabled: managedDiscordBusy,
						children: managedDiscordBusy ? "..." : elizaCloudConnected ? t("pluginsview.UseManagedDiscord", { defaultValue: "Use managed Discord" }) : t("pluginsview.OpenElizaCloud", { defaultValue: "Open Eliza Cloud" })
					}),
					children: [elizaCloudConnected ? t("pluginsview.ManagedDiscordGatewayHintConnected", { defaultValue: "Prefer OAuth? Managed Discord uses a shared gateway and only works for servers owned by the linking Discord account." }) : t("pluginsview.ManagedDiscordGatewayHint", { defaultValue: "Prefer OAuth? Connect Eliza Cloud to use the shared Discord gateway instead of a local bot token." }), managedDiscordPickerOpen && managedDiscordAgents.length > 1 ? (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-3 flex flex-col gap-2 sm:flex-row sm:items-center",
						children: [(0, import_jsx_runtime.jsxs)(Select, {
							value: managedDiscordSelectedAgentId ?? "__none__",
							onValueChange: (next) => setManagedDiscordSelectedAgentId(next === "__none__" ? null : next),
							children: [(0, import_jsx_runtime.jsx)(SelectTrigger, {
								className: "h-9 min-w-[14rem] rounded-[var(--radius-lg)] border-border/40 bg-bg/80 text-sm",
								children: (0, import_jsx_runtime.jsx)(SelectValue, { placeholder: t("pluginsview.ManagedDiscordSelectAgent", { defaultValue: "Select a cloud agent" }) })
							}), (0, import_jsx_runtime.jsx)(SelectContent, { children: managedDiscordAgents.map((agent) => (0, import_jsx_runtime.jsx)(SelectItem, {
								value: agent.agent_id,
								children: agent.agent_name || agent.agent_id
							}, agent.agent_id)) })]
						}), (0, import_jsx_runtime.jsx)(Button, {
							variant: "default",
							size: "sm",
							className: "h-9 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold",
							onClick: () => {
								handleConfirmManagedDiscordAgent();
							},
							disabled: managedDiscordBusy || !managedDiscordSelectedAgentId,
							children: managedDiscordBusy ? "..." : t("common.continue", { defaultValue: "Continue" })
						})]
					}) : null]
				}),
				cloudOAuthConnector ? (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
					tone: "default",
					className: "mb-4",
					actions: (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold",
						onClick: () => {
							handleOpenCloudOAuthConnector();
						},
						disabled: cloudOAuthBusy,
						children: cloudOAuthBusy ? "..." : elizaCloudConnected ? cloudOAuthConnector.buttonLabel : t("pluginsview.OpenElizaCloud", { defaultValue: "Open Eliza Cloud" })
					}),
					children: elizaCloudConnected ? cloudOAuthConnector.connectedHint : cloudOAuthConnector.disconnectedHint
				}) : null,
				showTelegramCloudGatewayNotice ? (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
					tone: "default",
					className: "mb-4",
					actions: elizaCloudConnected ? void 0 : (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold",
						onClick: () => {
							setState("cloudDashboardView", "billing");
							setTab("settings");
						},
						children: t("pluginsview.OpenElizaCloud", { defaultValue: "Open Eliza Cloud" })
					}),
					children: elizaCloudConnected ? t("pluginsview.TelegramCloudGatewayHint", { defaultValue: "Telegram does not support bot-install OAuth for bidirectional chats. Use a BotFather token here; Eliza Cloud can host the webhook gateway and route updates to this app." }) : t("pluginsview.TelegramCloudGatewayHintDisconnected", { defaultValue: "Telegram does not support bot-install OAuth for bidirectional chats. Connect Eliza Cloud to host the webhook gateway, then use a BotFather token here." })
				}) : null,
				pluginLinks.length > 0 && (0, import_jsx_runtime.jsx)("div", {
					className: "mb-4 flex flex-wrap gap-2",
					children: pluginLinks.map((link) => (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-8 rounded-[var(--radius-lg)] border-border/40 bg-card/40 px-3 text-xs-tight font-semibold text-muted transition-all hover:border-accent hover:bg-accent/5 hover:text-txt",
						onClick: () => {
							handleOpenPluginExternalUrl(link.url);
						},
						title: `${pluginResourceLinkLabel(t, link.key)}: ${link.url}`,
						children: pluginResourceLinkLabel(t, link.key)
					}, `${plugin.id}:${link.key}`))
				}),
				isStoreInstallMissing && !plugin.loadError && (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
					tone: "warning",
					className: "mb-4",
					actions: (0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						className: "h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-bold",
						disabled: installingPlugins.has(plugin.id),
						onClick: () => void handleInstallPlugin(plugin.id, plugin.npmName ?? ""),
						children: installingPlugins.has(plugin.id) ? installProgressLabel(installProgress.get(plugin.npmName ?? "")?.message) : installPluginLabel
					}),
					children: connectorInstallPrompt
				}),
				showPluginConfig ? (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-4",
					children: [plugin.id === "telegram" ? (0, import_jsx_runtime.jsx)(TelegramPluginConfig, {
						plugin,
						pluginConfigs,
						onParamChange: handleParamChange
					}) : (0, import_jsx_runtime.jsx)(PluginConfigForm, {
						plugin,
						pluginConfigs,
						onParamChange: handleParamChange
					}), connectorSetupPanel]
				}) : supportsConnectorSetupPanel ? connectorSetupPanel : (0, import_jsx_runtime.jsx)("div", {
					className: "text-sm text-muted",
					children: noConfigurationNeededLabel
				}),
				plugin.validationErrors && plugin.validationErrors.length > 0 && (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
					tone: "danger",
					className: "mt-3 text-xs",
					children: plugin.validationErrors.map((error) => (0, import_jsx_runtime.jsxs)("div", { children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: "font-medium text-warn",
							children: error.field
						}),
						":",
						" ",
						error.message
					] }, `${plugin.id}:${error.field}:${error.message}`))
				}),
				plugin.validationWarnings && plugin.validationWarnings.length > 0 && (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
					tone: "default",
					className: "mt-3 text-xs",
					children: plugin.validationWarnings.map((warning) => (0, import_jsx_runtime.jsx)("div", { children: warning.message }, `${plugin.id}:${warning.field}:${warning.message}`))
				}),
				plugin.version ? (0, import_jsx_runtime.jsx)("div", {
					className: "mt-4",
					children: (0, import_jsx_runtime.jsxs)(PagePanel.Meta, {
						compact: true,
						tone: "strong",
						className: "font-mono",
						children: ["v", plugin.version]
					})
				}) : null,
				(0, import_jsx_runtime.jsxs)("div", {
					className: "mt-4 flex flex-wrap items-center gap-2",
					children: [plugin.isActive && (0, import_jsx_runtime.jsx)(Button, {
						variant: testResult?.success ? "default" : testResult?.error ? "destructive" : "outline",
						size: "sm",
						className: `h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-bold transition-all ${testResult?.loading ? "cursor-wait opacity-70" : testResult?.success ? "border-ok bg-ok text-ok-fg hover:bg-ok/90" : testResult?.error ? "border-danger bg-danger text-danger-fg hover:bg-danger/90" : "border-border/40 bg-card/40 hover:border-accent/40"}`,
						disabled: testResult?.loading,
						onClick: () => void handleTestConnection(plugin.id),
						children: formatTestConnectionLabel(testResult)
					}), hasParams && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold text-muted hover:text-txt",
						onClick: () => handleConfigReset(plugin.id),
						children: t("common.reset")
					}), (0, import_jsx_runtime.jsx)(Button, {
						variant: saveSuccess ? "default" : "secondary",
						size: "sm",
						className: `h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-bold transition-all ${saveSuccess ? "bg-ok text-ok-fg hover:bg-ok/90" : "bg-accent text-accent-fg hover:bg-accent/90"}`,
						onClick: () => void handleConfigSave(plugin.id),
						disabled: isSaving,
						children: formatSaveSettingsLabel(isSaving, saveSuccess)
					})] })]
				})
			]
		})
	}, plugin.id);
}
function ConnectorPluginGroups(props) {
	const groups = groupVisiblePlugins(props.visiblePlugins);
	if (groups.length === 1) return groups[0].plugins.map((plugin) => (0, import_jsx_runtime.jsx)(ConnectorPluginCard, {
		...props,
		plugin
	}, plugin.id));
	return groups.map((group) => (0, import_jsx_runtime.jsxs)("div", {
		className: "relative rounded-[var(--radius-lg)] border border-border/30 px-2 pb-2 pt-5",
		children: [(0, import_jsx_runtime.jsx)("span", {
			className: "absolute -top-2.5 left-3 bg-bg px-2 text-2xs font-semibold uppercase tracking-wider text-muted",
			children: group.label
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "space-y-4",
			children: group.plugins.map((plugin) => (0, import_jsx_runtime.jsx)(ConnectorPluginCard, {
				...props,
				plugin
			}, plugin.id))
		})]
	}, group.id));
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/plugin-view-dialogs.js
function SettingsDialogIcon({ plugin }) {
	const icon = resolveIcon(plugin);
	if (!icon) return null;
	if (typeof icon === "string") {
		const imageSrc = iconImageSource(icon);
		return imageSrc ? (0, import_jsx_runtime.jsx)("img", {
			src: imageSrc,
			alt: "",
			className: "w-6 h-6 rounded-md object-contain",
			onError: (event) => {
				event.currentTarget.style.display = "none";
			}
		}) : (0, import_jsx_runtime.jsx)("span", {
			className: "text-base",
			children: icon
		});
	}
	return (0, import_jsx_runtime.jsx)(icon, { className: "w-6 h-6 text-txt" });
}
function PluginSettingsDialog({ installPluginLabel, installProgress, installingPlugins, pluginConfigs, pluginSaveSuccess, pluginSaving, settingsDialogPlugin, t, testResults, onClose, onConfigReset, onConfigSave, onInstallPlugin, onParamChange, onTestConnection, formatDialogTestConnectionLabel, installProgressLabel, saveSettingsLabel, savingLabel }) {
	if (!settingsDialogPlugin) return null;
	const plugin = settingsDialogPlugin;
	const isShowcase = plugin.id === "__ui-showcase__";
	const isSaving = pluginSaving.has(plugin.id);
	const saveSuccess = pluginSaveSuccess.has(plugin.id);
	const categoryLabel = isShowcase ? "showcase" : plugin.category === "ai-provider" ? "ai provider" : plugin.category;
	return (0, import_jsx_runtime.jsx)(Dialog, {
		open: true,
		onOpenChange: (open) => {
			if (!open) onClose(plugin.id);
		},
		children: (0, import_jsx_runtime.jsxs)(AdminDialog.Content, {
			className: "max-h-[85vh] max-w-2xl",
			children: [
				(0, import_jsx_runtime.jsxs)(AdminDialog.Header, {
					className: "flex flex-row items-center gap-3",
					children: [
						(0, import_jsx_runtime.jsxs)(DialogTitle, {
							className: "font-bold text-base flex items-center gap-2 flex-1 min-w-0 tracking-wide text-txt",
							children: [(0, import_jsx_runtime.jsx)(SettingsDialogIcon, { plugin }), plugin.name]
						}),
						(0, import_jsx_runtime.jsx)(DialogDescription, {
							className: "sr-only",
							children: t("pluginsview.PluginDialogDescription", {
								plugin: plugin.name,
								defaultValue: "Review plugin metadata, adjust settings, and save changes for {{plugin}}."
							})
						}),
						(0, import_jsx_runtime.jsx)(AdminDialog.MetaBadge, { children: categoryLabel }),
						plugin.version && (0, import_jsx_runtime.jsxs)(AdminDialog.MonoMeta, { children: ["v", plugin.version] }),
						isShowcase && (0, import_jsx_runtime.jsx)("span", {
							className: "text-2xs font-bold tracking-widest px-2.5 py-[2px] border border-accent/30 text-txt bg-accent/10 rounded-full",
							children: t("pluginsview.DEMO")
						})
					]
				}),
				(0, import_jsx_runtime.jsxs)(AdminDialog.BodyScroll, { children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "px-5 pt-4 pb-1 flex items-center gap-3 flex-wrap text-xs text-muted",
						children: [plugin.description && (0, import_jsx_runtime.jsx)("span", {
							className: "text-xs text-muted leading-relaxed",
							children: plugin.description
						}), (plugin.tags?.length ?? 0) > 0 && (0, import_jsx_runtime.jsx)("span", {
							className: "flex items-center gap-1.5 flex-wrap",
							children: plugin.tags?.map((tag) => (0, import_jsx_runtime.jsx)("span", {
								className: "whitespace-nowrap border border-border/40 bg-bg-accent/80 px-1.5 py-px text-2xs lowercase tracking-wide text-muted-strong",
								children: tag
							}, `${plugin.id}:${tag}:settings`))
						})]
					}),
					(plugin.npmName || plugin.pluginDeps && plugin.pluginDeps.length > 0) && (0, import_jsx_runtime.jsxs)("div", {
						className: "px-5 pb-2 flex items-center gap-3 flex-wrap",
						children: [plugin.npmName && (0, import_jsx_runtime.jsx)("span", {
							className: "font-mono text-2xs text-muted opacity-50",
							children: plugin.npmName
						}), plugin.pluginDeps && plugin.pluginDeps.length > 0 && (0, import_jsx_runtime.jsxs)("span", {
							className: "flex items-center gap-1 flex-wrap",
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: "text-2xs text-muted opacity-60",
								children: t("pluginsview.dependsOn")
							}), plugin.pluginDeps.map((dep) => (0, import_jsx_runtime.jsx)("span", {
								className: "text-2xs px-1.5 py-px border border-border bg-accent-subtle text-muted rounded-sm",
								children: dep
							}, dep))]
						})]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "px-5 py-3",
						children: [plugin.id === "telegram" ? (0, import_jsx_runtime.jsx)(TelegramPluginConfig, {
							plugin,
							pluginConfigs,
							onParamChange
						}) : (0, import_jsx_runtime.jsx)(PluginConfigForm, {
							plugin,
							pluginConfigs,
							onParamChange
						}), (0, import_jsx_runtime.jsx)(ConnectorSetupPanel, { pluginId: plugin.id })]
					})
				] }),
				!isShowcase && (0, import_jsx_runtime.jsxs)(AdminDialog.Footer, {
					className: "flex justify-end gap-3",
					children: [
						plugin.source === "store" && plugin.enabled && !plugin.isActive && plugin.npmName && !plugin.loadError && (0, import_jsx_runtime.jsx)(Button, {
							variant: "default",
							size: "sm",
							className: "h-8 px-4 text-xs-tight font-bold tracking-wide shadow-sm",
							disabled: installingPlugins.has(plugin.id),
							onClick: () => void onInstallPlugin(plugin.id, plugin.npmName ?? ""),
							children: installingPlugins.has(plugin.id) ? installProgressLabel(installProgress.get(plugin.npmName ?? "")?.message) : installPluginLabel
						}),
						plugin.loadError && (0, import_jsx_runtime.jsx)("span", {
							className: "px-3 py-1.5 text-xs-tight text-danger font-bold tracking-wide",
							title: plugin.loadError,
							children: t("pluginsview.PackageBrokenMis")
						}),
						plugin.isActive && (0, import_jsx_runtime.jsx)(Button, {
							variant: testResults.get(plugin.id)?.success ? "default" : testResults.get(plugin.id)?.error ? "destructive" : "outline",
							size: "sm",
							className: `h-8 px-4 text-xs-tight font-bold tracking-wide transition-all ${testResults.get(plugin.id)?.loading ? "opacity-70 cursor-wait" : testResults.get(plugin.id)?.success ? "bg-ok text-ok-fg border-ok hover:bg-ok/90" : testResults.get(plugin.id)?.error ? "bg-danger text-danger-fg border-danger hover:bg-danger/90" : "border-border/40 bg-card/40 backdrop-blur-md shadow-sm hover:border-accent/40"}`,
							disabled: testResults.get(plugin.id)?.loading,
							onClick: () => void onTestConnection(plugin.id),
							children: formatDialogTestConnectionLabel(testResults.get(plugin.id))
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							variant: "ghost",
							size: "sm",
							className: "h-8 px-4 text-xs font-bold text-muted hover:text-txt transition-all",
							onClick: () => onConfigReset(plugin.id),
							children: t("common.reset")
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							variant: saveSuccess ? "default" : "secondary",
							size: "sm",
							className: `h-8 px-5 text-xs font-bold tracking-wide transition-all ${saveSuccess ? "bg-ok text-ok-fg hover:bg-ok/90" : "bg-accent text-accent-fg hover:bg-accent/90 shadow-lg shadow-accent/20"}`,
							onClick: () => void onConfigSave(plugin.id),
							disabled: isSaving,
							children: isSaving ? savingLabel : saveSuccess ? t("pluginsview.SavedWithCheck", { defaultValue: "✓ Saved" }) : saveSettingsLabel
						})
					]
				})
			]
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/plugin-view-modal.js
function ResolvedPluginIcon({ plugin, emojiClassName, iconClassName, imageClassName, imageStyle }) {
	const icon = resolveIcon(plugin);
	if (!icon) return "🧩";
	if (typeof icon === "string") {
		const imageSrc = iconImageSource(icon);
		return imageSrc ? (0, import_jsx_runtime.jsx)("img", {
			src: imageSrc,
			alt: "",
			className: imageClassName,
			style: imageStyle
		}) : (0, import_jsx_runtime.jsx)("span", {
			className: emojiClassName,
			children: icon
		});
	}
	return (0, import_jsx_runtime.jsx)(icon, { className: iconClassName });
}
function PluginGameModal({ effectiveGameSelected, gameMobileDetail, gameNarrow, gameVisiblePlugins, isConnectorLikeMode, pluginConfigs, pluginSaveSuccess, pluginSaving, resultLabel, saveLabel, savedLabel, savingLabel, sectionTitle, selectedPlugin, selectedPluginLinks, t, togglingPlugins, onBack, onConfigSave, onOpenExternalUrl, onParamChange, onSelectPlugin, onTestConnection, onTogglePlugin }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "plugins-game-modal plugins-game-modal--inline",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: `plugins-game-list-panel${gameNarrow && gameMobileDetail ? " is-hidden" : ""}`,
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "plugins-game-list-head",
				children: (0, import_jsx_runtime.jsx)("div", {
					className: "plugins-game-section-title",
					children: sectionTitle
				})
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "plugins-game-list-scroll",
				role: "listbox",
				"aria-label": `${sectionTitle} list`,
				children: gameVisiblePlugins.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
					className: "plugins-game-list-empty",
					children: t("pluginsview.NoResultsFound", {
						label: resultLabel,
						defaultValue: "No {{label}} found"
					})
				}) : gameVisiblePlugins.map((plugin) => (0, import_jsx_runtime.jsxs)(Button, {
					variant: "ghost",
					type: "button",
					role: "option",
					"aria-selected": effectiveGameSelected === plugin.id,
					className: `plugins-game-card${effectiveGameSelected === plugin.id ? " is-selected" : ""}${!plugin.enabled ? " is-disabled" : ""} h-auto`,
					onClick: () => onSelectPlugin(plugin.id),
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "plugins-game-card-icon-shell",
						children: (0, import_jsx_runtime.jsx)("span", {
							className: "plugins-game-card-icon",
							children: (0, import_jsx_runtime.jsx)(ResolvedPluginIcon, {
								plugin,
								imageClassName: "plugins-game-card-icon",
								imageStyle: { objectFit: "contain" },
								iconClassName: "w-5 h-5"
							})
						})
					}), (0, import_jsx_runtime.jsxs)("div", {
						className: "plugins-game-card-body",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "plugins-game-card-name",
							children: plugin.name
						}), (0, import_jsx_runtime.jsx)("div", {
							className: "plugins-game-card-meta",
							children: (0, import_jsx_runtime.jsx)("span", {
								className: `plugins-game-badge ${plugin.enabled ? "is-on" : "is-off"}`,
								children: plugin.enabled ? t("common.on") : t("common.off")
							})
						})]
					})]
				}, plugin.id))
			})]
		}), (0, import_jsx_runtime.jsx)("div", {
			className: `plugins-game-detail-panel${gameNarrow && !gameMobileDetail ? " is-hidden" : ""}`,
			children: selectedPlugin ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
				(0, import_jsx_runtime.jsxs)("div", {
					className: "plugins-game-detail-head",
					children: [gameNarrow && (0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						type: "button",
						className: "plugins-game-back-btn",
						onClick: onBack,
						children: t("common.back")
					}), (0, import_jsx_runtime.jsxs)("div", {
						className: "plugins-game-detail-title-row",
						children: [
							(0, import_jsx_runtime.jsx)("div", {
								className: "plugins-game-detail-icon-shell",
								children: (0, import_jsx_runtime.jsx)("span", {
									className: "plugins-game-detail-icon",
									children: (0, import_jsx_runtime.jsx)(ResolvedPluginIcon, {
										plugin: selectedPlugin,
										imageClassName: "plugins-game-detail-icon",
										iconClassName: "w-6 h-6"
									})
								})
							}),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "plugins-game-detail-main",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "plugins-game-detail-name",
									children: selectedPlugin.name
								}), selectedPlugin.version && (0, import_jsx_runtime.jsxs)("span", {
									className: "plugins-game-version",
									children: ["v", selectedPlugin.version]
								})]
							}),
							(0, import_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								type: "button",
								className: `plugins-game-toggle ${selectedPlugin.enabled ? "is-on" : "is-off"}`,
								onClick: () => void onTogglePlugin(selectedPlugin.id, !selectedPlugin.enabled),
								disabled: togglingPlugins.has(selectedPlugin.id),
								children: selectedPlugin.enabled ? t("common.on") : t("common.off")
							})
						]
					})]
				}),
				(0, import_jsx_runtime.jsx)("div", {
					className: "plugins-game-detail-description",
					children: selectedPlugin.description
				}),
				(selectedPlugin.tags?.length ?? 0) > 0 && (0, import_jsx_runtime.jsx)("div", {
					className: "flex flex-wrap gap-1.5 px-3 pb-3",
					children: selectedPlugin.tags?.map((tag) => (0, import_jsx_runtime.jsx)("span", {
						className: "text-2xs px-1.5 py-px border border-border bg-black/10 text-muted lowercase tracking-wide whitespace-nowrap",
						children: tag
					}, `${selectedPlugin.id}:${tag}`))
				}),
				selectedPluginLinks.length > 0 && (0, import_jsx_runtime.jsx)("div", {
					className: "plugins-game-detail-links flex flex-wrap gap-2 px-3 pb-3",
					children: selectedPluginLinks.map((link) => (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						type: "button",
						className: "plugins-game-link-btn border border-border bg-transparent px-2.5 py-1 text-xs-tight text-muted transition-colors hover:border-accent hover:text-txt",
						onClick: () => {
							onOpenExternalUrl(link.url);
						},
						children: pluginResourceLinkLabel(t, link.key)
					}, `${selectedPlugin.id}:${link.key}`))
				}),
				selectedPlugin.parameters && selectedPlugin.parameters.length > 0 && (0, import_jsx_runtime.jsx)("div", {
					className: "plugins-game-detail-config",
					children: selectedPlugin.parameters.map((param) => (0, import_jsx_runtime.jsxs)("div", {
						id: `field-${param.key}`,
						children: [(0, import_jsx_runtime.jsx)("label", {
							htmlFor: `input-${param.key}`,
							className: "text-xs-tight tracking-wider text-muted block mb-1",
							children: param.key
						}), (0, import_jsx_runtime.jsx)(Input, {
							id: `input-${param.key}`,
							type: param.sensitive ? "password" : "text",
							className: "w-full px-2 py-1 text-xs",
							placeholder: param.description,
							value: pluginConfigs[selectedPlugin.id]?.[param.key] ?? param.currentValue ?? "",
							onChange: (event) => onParamChange(selectedPlugin.id, param.key, event.target.value)
						})]
					}, param.key))
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "plugins-game-detail-actions",
					children: [(0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						type: "button",
						className: "plugins-game-action-btn",
						onClick: () => void onTestConnection(selectedPlugin.id),
						children: t("pluginsview.TestConnection")
					}), (0, import_jsx_runtime.jsx)(Button, {
						variant: "default",
						size: "sm",
						type: "button",
						className: `plugins-game-action-btn plugins-game-save-btn${pluginSaveSuccess.has(selectedPlugin.id) ? " is-saved" : ""}`,
						onClick: () => void onConfigSave(selectedPlugin.id),
						disabled: pluginSaving.has(selectedPlugin.id),
						children: pluginSaving.has(selectedPlugin.id) ? savingLabel : pluginSaveSuccess.has(selectedPlugin.id) ? savedLabel : saveLabel
					})]
				})
			] }) : (0, import_jsx_runtime.jsxs)("div", {
				className: "plugins-game-detail-empty",
				children: [(0, import_jsx_runtime.jsx)("span", {
					className: "plugins-game-detail-empty-icon",
					children: "🧩"
				}), (0, import_jsx_runtime.jsxs)("span", {
					className: "plugins-game-detail-empty-text",
					children: [
						t("pluginsview.SelectA"),
						" ",
						isConnectorLikeMode ? "connector" : "plugin",
						" ",
						t("pluginsview.toC")
					]
				})]
			})
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/plugin-view-sidebar.js
function ConnectorSidebar({ collapseLabel, connectorExpandedIds, connectorSelectedId, desktopConnectorLayout, expandLabel, hasPluginToggleInFlight, mode, pluginSearch, registerConnectorRailItem, registerConnectorSidebarItem, registerConnectorSidebarViewport, renderResolvedIcon, resultLabel, subgroupFilter, subgroupTags, t, togglingPlugins, visiblePlugins, onConnectorSelect, onConnectorSectionToggle, onSearchChange, onSearchClear, onSubgroupFilterChange, onTogglePlugin }) {
	if (!desktopConnectorLayout) return null;
	const sidebarSearchLabel = mode === "social" ? "Search connectors" : "Search plugins";
	const filterSelectLabel = subgroupTags.find((tag) => tag.id === subgroupFilter)?.label ?? "All";
	const hasActivePluginFilters = pluginSearch.trim().length > 0 || subgroupFilter !== "all";
	return (0, import_jsx_runtime.jsx)(AppPageSidebar, {
		ref: registerConnectorSidebarViewport,
		testId: "connectors-settings-sidebar",
		collapsible: true,
		contentIdentity: mode === "social" ? "connectors" : "plugins",
		header: (0, import_jsx_runtime.jsx)(SidebarHeader, { search: {
			value: pluginSearch,
			onChange: (event) => onSearchChange(event.target.value),
			onClear: onSearchClear,
			placeholder: sidebarSearchLabel,
			"aria-label": sidebarSearchLabel
		} }),
		collapsedRailItems: visiblePlugins.map((plugin) => {
			const isSelected = connectorSelectedId === plugin.id;
			const RailBrandIcon = getBrandIcon(plugin.id);
			return (0, import_jsx_runtime.jsx)(SidebarContent.RailItem, {
				ref: registerConnectorRailItem(plugin.id),
				"aria-label": plugin.name,
				title: plugin.name,
				active: isSelected,
				indicatorTone: plugin.enabled ? "accent" : void 0,
				onClick: () => onConnectorSelect(plugin.id),
				children: (0, import_jsx_runtime.jsx)(SidebarContent.RailMedia, { children: RailBrandIcon ? (0, import_jsx_runtime.jsx)(RailBrandIcon, { className: "h-5 w-5 shrink-0" }) : renderResolvedIcon(plugin) })
			}, plugin.id);
		}),
		children: (0, import_jsx_runtime.jsx)(SidebarScrollRegion, { children: (0, import_jsx_runtime.jsxs)(SidebarPanel, { children: [(0, import_jsx_runtime.jsx)("div", {
			className: "mb-3",
			children: (0, import_jsx_runtime.jsxs)(Select, {
				value: subgroupFilter,
				onValueChange: onSubgroupFilterChange,
				children: [(0, import_jsx_runtime.jsx)(SettingsControls.SelectTrigger, {
					"aria-label": mode === "social" ? "Filter connector category" : "Filter plugin category",
					variant: "filter",
					className: "w-full",
					children: (0, import_jsx_runtime.jsx)(SelectValue, { children: filterSelectLabel })
				}), (0, import_jsx_runtime.jsx)(SelectContent, { children: subgroupTags.map((tag) => (0, import_jsx_runtime.jsxs)(SelectItem, {
					value: tag.id,
					children: [
						tag.label,
						" (",
						tag.count,
						")"
					]
				}, tag.id)) })]
			})
		}), visiblePlugins.length === 0 ? (0, import_jsx_runtime.jsx)(SidebarContent.EmptyState, {
			className: "px-4 py-6",
			children: hasActivePluginFilters ? `No ${resultLabel} match the current filters.` : `No ${resultLabel} available.`
		}) : visiblePlugins.map((plugin) => {
			const isSelected = connectorSelectedId === plugin.id;
			const isExpanded = connectorExpandedIds.has(plugin.id);
			const isToggleBusy = togglingPlugins.has(plugin.id);
			const toggleDisabled = isToggleBusy || hasPluginToggleInFlight && !isToggleBusy;
			const SidebarBrandIcon = getBrandIcon(plugin.id);
			return (0, import_jsx_runtime.jsxs)(SidebarContent.Item, {
				as: "div",
				active: isSelected,
				className: "items-center gap-1.5 px-2.5 py-2 scroll-mt-3",
				ref: registerConnectorSidebarItem(plugin.id),
				children: [(0, import_jsx_runtime.jsxs)(SidebarContent.ItemButton, {
					role: "option",
					"aria-selected": isSelected,
					onClick: () => onConnectorSelect(plugin.id),
					"aria-current": isSelected ? "page" : void 0,
					className: "items-center gap-2",
					children: [(0, import_jsx_runtime.jsx)(SidebarContent.ItemIcon, {
						active: isSelected,
						className: "mt-0 h-8 w-8 shrink-0 p-1.5",
						children: SidebarBrandIcon ? (0, import_jsx_runtime.jsx)(SidebarBrandIcon, { className: "h-4 w-4 shrink-0" }) : renderResolvedIcon(plugin, {
							className: "h-4 w-4 shrink-0 rounded-[var(--radius-sm)] object-contain",
							emojiClassName: "text-sm"
						})
					}), (0, import_jsx_runtime.jsx)(SidebarContent.ItemBody, { children: (0, import_jsx_runtime.jsx)("span", {
						className: "block truncate text-sm font-semibold leading-5 text-txt",
						children: plugin.name
					}) })]
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex shrink-0 flex-row items-center gap-1",
					children: [(0, import_jsx_runtime.jsx)(Switch, {
						checked: plugin.enabled,
						disabled: toggleDisabled,
						onClick: (event) => event.stopPropagation(),
						onKeyDown: (event) => event.stopPropagation(),
						onCheckedChange: (checked) => {
							onTogglePlugin(plugin.id, checked);
						},
						"aria-label": `${plugin.enabled ? t("common.off") : t("common.on")} ${plugin.name}`
					}), (0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "icon",
						className: "h-8 w-8 shrink-0 rounded-none border-0 bg-transparent text-muted transition-colors hover:bg-transparent hover:text-txt",
						"aria-label": `${isExpanded ? collapseLabel : expandLabel} ${plugin.name} in sidebar`,
						onClick: (event) => {
							event.stopPropagation();
							onConnectorSectionToggle(plugin.id);
						},
						children: (0, import_jsx_runtime.jsx)(ChevronRight, { className: `h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}` })
					})]
				})]
			}, plugin.id);
		})] }) })
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/PluginsView.js
function PluginListView({ label, contentHeader, mode = "all", inModal }) {
	const { plugins = [], pluginStatusFilter = "all", pluginSearch = "", pluginSettingsOpen = /* @__PURE__ */ new Set(), pluginSaving, pluginSaveSuccess, loadPlugins, ensurePluginsLoaded = async () => {
		await loadPlugins();
	}, handlePluginToggle, handlePluginConfigSave, setActionNotice, setState, t } = useApp();
	const [pluginConfigs, setPluginConfigs] = useState({});
	const [testResults, setTestResults] = useState(/* @__PURE__ */ new Map());
	const [installingPlugins, setInstallingPlugins] = useState(/* @__PURE__ */ new Set());
	const [installProgress, setInstallProgress] = useState(/* @__PURE__ */ new Map());
	const [updatingPlugins, setUpdatingPlugins] = useState(/* @__PURE__ */ new Set());
	const [uninstallingPlugins, setUninstallingPlugins] = useState(/* @__PURE__ */ new Set());
	const [pluginReleaseStreams, setPluginReleaseStreams] = useState({});
	const pluginDescriptionFallback = t("pluginsview.NoDescriptionAvailable", { defaultValue: "No description available" });
	const installProgressLabel = (message) => message || t("common.installing", { defaultValue: "Installing..." });
	const installPluginLabel = t("pluginsview.InstallPlugin", { defaultValue: "Install Plugin" });
	const installLabel = t("common.install", { defaultValue: "Install" });
	const testingLabel = t("common.testing", { defaultValue: "Testing..." });
	const saveSettingsLabel = t("pluginsview.SaveSettings", { defaultValue: "Save Settings" });
	const saveLabel = t("common.save", { defaultValue: "Save" });
	const savingLabel = t("common.saving", { defaultValue: "Saving..." });
	const savedLabel = t("common.saved", { defaultValue: "Saved" });
	const savedWithBangLabel = t("pluginsview.SavedWithBang", { defaultValue: "Saved!" });
	const readyLabel = t("common.ready", { defaultValue: "Ready" });
	const needsSetupLabel = t("common.needsSetup", { defaultValue: "Needs setup" });
	const loadFailedLabel = t("pluginsview.LoadFailed", { defaultValue: "Load failed" });
	const notInstalledLabel = t("pluginsview.NotInstalled", { defaultValue: "Not installed" });
	const expandLabel = t("common.expand", { defaultValue: "Expand" });
	const collapseLabel = t("common.collapse", { defaultValue: "Collapse" });
	const noConfigurationNeededLabel = t("pluginsview.NoConfigurationNeeded", { defaultValue: "No configuration needed." });
	const connectorInstallPrompt = t("pluginsview.InstallConnectorPrompt", { defaultValue: "Install this connector to activate it in the runtime." });
	const formatTestConnectionLabel = (result) => {
		if (result?.loading) return testingLabel;
		if (result?.success) return t("pluginsview.ConnectionTestPassed", {
			durationMs: result.durationMs,
			defaultValue: "OK ({{durationMs}}ms)"
		});
		if (result?.error) return t("pluginsview.ConnectionTestFailed", {
			error: result.error,
			defaultValue: "Failed: {{error}}"
		});
		return t("pluginsview.TestConnection");
	};
	const formatDialogTestConnectionLabel = (result) => {
		if (result?.loading) return testingLabel;
		if (result?.success) return t("pluginsview.ConnectionTestPassedDialog", {
			durationMs: result.durationMs,
			defaultValue: "✓ OK ({{durationMs}}ms)"
		});
		if (result?.error) return t("pluginsview.ConnectionTestFailedDialog", {
			error: result.error,
			defaultValue: "✕ {{error}}"
		});
		return t("pluginsview.TestConnection");
	};
	const formatSaveSettingsLabel = (isSaving, didSave) => {
		if (isSaving) return savingLabel;
		if (didSave) return savedLabel;
		return saveSettingsLabel;
	};
	const [togglingPlugins, setTogglingPlugins] = useState(/* @__PURE__ */ new Set());
	const hasPluginToggleInFlight = togglingPlugins.size > 0;
	const [pluginOrder, setPluginOrder] = useState(() => {
		try {
			const stored = localStorage.getItem("pluginOrder");
			return stored ? JSON.parse(stored) : [];
		} catch {
			return [];
		}
	});
	const [draggingId, setDraggingId] = useState(null);
	const [dragOverId, setDragOverId] = useState(null);
	const dragRef = useRef(null);
	const isConnectorShellMode = mode === "social";
	const isSocialMode = mode === "social" || mode === "all-social";
	const isSidebarEditorShellMode = mode === "social" || mode === "all-social";
	const isConnectorLikeMode = mode === "connectors" || mode === "social";
	const resultLabel = mode === "social" ? "connectors" : label.toLowerCase();
	const effectiveStatusFilter = isSidebarEditorShellMode ? pluginStatusFilter : "all";
	const effectiveSearch = isSidebarEditorShellMode ? pluginSearch : "";
	const allowCustomOrder = !isSocialMode;
	useEffect(() => {
		ensurePluginsLoaded();
	}, [ensurePluginsLoaded]);
	useEffect(() => {
		return client.onWsEvent("install-progress", (data) => {
			const pluginName = data.pluginName;
			const phase = data.phase;
			const message = data.message;
			if (!pluginName) return;
			if (phase === "complete" || phase === "error") setInstallProgress((prev) => {
				const next = new Map(prev);
				next.delete(pluginName);
				return next;
			});
			else setInstallProgress((prev) => new Map(prev).set(pluginName, {
				phase,
				message
			}));
		});
	}, []);
	useEffect(() => {
		if (pluginOrder.length > 0) localStorage.setItem("pluginOrder", JSON.stringify(pluginOrder));
	}, [pluginOrder]);
	const [subgroupFilter, setSubgroupFilter] = useState("all");
	const showSubgroupFilters = mode !== "connectors" && mode !== "streaming" && mode !== "social";
	const showDesktopSubgroupSidebar = showSubgroupFilters;
	const { nonDbPlugins, sorted, subgroupTags, visiblePlugins } = useMemo(() => buildPluginListState({
		allowCustomOrder,
		effectiveSearch,
		effectiveStatusFilter,
		isConnectorLikeMode,
		mode,
		pluginOrder,
		plugins,
		showSubgroupFilters,
		subgroupFilter
	}), [
		allowCustomOrder,
		effectiveSearch,
		effectiveStatusFilter,
		isConnectorLikeMode,
		mode,
		pluginOrder,
		plugins,
		showSubgroupFilters,
		subgroupFilter
	]);
	useEffect(() => {
		if (!showSubgroupFilters) return;
		if (subgroupFilter === "all") return;
		if (!subgroupTags.some((tag) => tag.id === subgroupFilter)) setSubgroupFilter("all");
	}, [
		showSubgroupFilters,
		subgroupFilter,
		subgroupTags
	]);
	const renderSubgroupFilterButton = useCallback((tag, options) => {
		const isActive = subgroupFilter === tag.id;
		if (options?.sidebar) {
			const Icon = SUBGROUP_NAV_ICONS[tag.id] ?? Package;
			return (0, import_jsx_runtime.jsxs)(SidebarContent.Item, {
				as: "button",
				onClick: () => setSubgroupFilter(tag.id),
				"aria-current": isActive ? "page" : void 0,
				active: isActive,
				className: "items-center",
				children: [
					(0, import_jsx_runtime.jsx)(SidebarContent.ItemIcon, {
						active: isActive,
						children: (0, import_jsx_runtime.jsx)(Icon, { className: "h-4 w-4" })
					}),
					(0, import_jsx_runtime.jsxs)(SidebarContent.ItemBody, { children: [(0, import_jsx_runtime.jsx)(SidebarContent.ItemTitle, {
						className: "whitespace-nowrap break-normal [overflow-wrap:normal]",
						children: tag.label
					}), (0, import_jsx_runtime.jsx)(SidebarContent.ItemDescription, { children: t("pluginsview.AvailableCount", {
						count: tag.count,
						defaultValue: "{{count}} available"
					}) })] }),
					(0, import_jsx_runtime.jsx)(PagePanel.Meta, {
						compact: true,
						tone: isActive ? "accent" : "default",
						className: "text-2xs font-bold tracking-[0.16em]",
						children: tag.count
					})
				]
			}, tag.id);
		}
		return (0, import_jsx_runtime.jsxs)(Button, {
			variant: isActive ? "default" : "outline",
			size: "sm",
			className: `h-7 px-3 text-xs-tight font-bold tracking-wide rounded-[var(--radius-md)] transition-all ${isActive ? "border-accent/55 bg-accent/16 text-txt-strong shadow-sm" : "bg-card/40 backdrop-blur-sm border-border/40 text-muted hover:text-txt shadow-sm hover:border-accent/30"}`,
			onClick: () => setSubgroupFilter(tag.id),
			children: [tag.label, (0, import_jsx_runtime.jsx)("span", {
				className: `ml-1.5 rounded border px-1.5 py-0.5 text-3xs font-mono leading-none ${isActive ? "border-accent/30 bg-accent/12 text-txt-strong" : "border-border/50 bg-bg-accent/80 text-muted-strong"}`,
				children: tag.count
			})]
		}, tag.id);
	}, [subgroupFilter, t]);
	const toggleSettings = (pluginId) => {
		const next = /* @__PURE__ */ new Set();
		if (!pluginSettingsOpen.has(pluginId)) next.add(pluginId);
		setState("pluginSettingsOpen", next);
	};
	const handleParamChange = (pluginId, paramKey, value) => {
		setPluginConfigs((prev) => ({
			...prev,
			[pluginId]: {
				...prev[pluginId],
				[paramKey]: value
			}
		}));
	};
	const handleConfigSave = async (pluginId) => {
		if (pluginId === "__ui-showcase__") return;
		await handlePluginConfigSave(pluginId, pluginConfigs[pluginId] ?? {});
		setPluginConfigs((prev) => {
			const next = { ...prev };
			delete next[pluginId];
			return next;
		});
	};
	const handleConfigReset = (pluginId) => {
		setPluginConfigs((prev) => {
			const next = { ...prev };
			delete next[pluginId];
			return next;
		});
	};
	const handleTestConnection = async (pluginId) => {
		setTestResults((prev) => {
			const next = new Map(prev);
			next.set(pluginId, {
				success: false,
				loading: true,
				durationMs: 0
			});
			return next;
		});
		try {
			const result = await client.testPluginConnection(pluginId);
			setTestResults((prev) => {
				const next = new Map(prev);
				next.set(pluginId, {
					...result,
					loading: false
				});
				return next;
			});
		} catch (err) {
			setTestResults((prev) => {
				const next = new Map(prev);
				next.set(pluginId, {
					success: false,
					error: err instanceof Error ? err.message : String(err),
					loading: false,
					durationMs: 0
				});
				return next;
			});
		}
	};
	const getSelectedReleaseStream = useCallback((plugin) => pluginReleaseStreams[plugin.id] ?? plugin.releaseStream ?? (plugin.alphaVersion ? "alpha" : "latest"), [pluginReleaseStreams]);
	const handleReleaseStreamChange = useCallback((pluginId, stream) => {
		setPluginReleaseStreams((prev) => {
			if (prev[pluginId] === stream) return prev;
			return {
				...prev,
				[pluginId]: stream
			};
		});
	}, []);
	const clearPluginReleaseStream = useCallback((pluginId) => {
		setPluginReleaseStreams((prev) => {
			if (!(pluginId in prev)) return prev;
			const next = { ...prev };
			delete next[pluginId];
			return next;
		});
	}, []);
	const runWithPluginManager = useCallback(async (_pluginName, _notices, task) => task(), []);
	const completePluginLifecycleRestart = useCallback(async (messages) => {
		setActionNotice(messages.waiting, "info", 12e4, false, true);
		const status = await client.restartAndWait(12e4);
		if (status.state !== "running") {
			setActionNotice(messages.failure.replace("{{status}}", status.state), "error", 3800);
			return false;
		}
		await loadPlugins();
		setActionNotice(messages.success, "success");
		return true;
	}, [loadPlugins, setActionNotice]);
	const handleInstallPlugin = async (pluginId, npmName) => {
		const plugin = plugins.find((candidate) => candidate.id === pluginId);
		const stream = plugin ? getSelectedReleaseStream(plugin) : "alpha";
		setInstallingPlugins((prev) => new Set(prev).add(pluginId));
		try {
			if ((await runWithPluginManager(npmName, {
				prepare: t("pluginsview.PluginInstallPreparing", {
					plugin: npmName,
					defaultValue: "Enabling plugin installs for {{plugin}} and restarting the agent..."
				}),
				recover: t("pluginsview.PluginInstallRecovering", {
					plugin: npmName,
					defaultValue: "Finishing plugin install setup for {{plugin}} and restarting the agent..."
				})
			}, async () => await client.installRegistryPlugin(npmName, false, { stream }))).requiresRestart) {
				if (!await completePluginLifecycleRestart({
					waiting: t("pluginsview.PluginInstalledRestarting", {
						plugin: npmName,
						defaultValue: "{{plugin}} installed. Restarting the agent and waiting for activation..."
					}),
					success: t("pluginsview.PluginInstalledRestartComplete", {
						plugin: npmName,
						defaultValue: "{{plugin}} installed and activated."
					}),
					failure: t("pluginsview.PluginInstalledRestartFailed", {
						plugin: npmName,
						status: "{{status}}",
						defaultValue: "{{plugin}} installed, but the agent did not come back online (status: {{status}})."
					})
				})) return;
			} else {
				await loadPlugins();
				setActionNotice(t("pluginsview.PluginInstalledActivated", {
					plugin: npmName,
					defaultValue: "{{plugin}} installed and activated without a full agent restart."
				}), "success");
			}
		} catch (err) {
			setActionNotice(t("pluginsview.PluginInstallFailed", {
				plugin: npmName,
				message: err instanceof Error ? err.message : "unknown error",
				defaultValue: "Failed to install {{plugin}}: {{message}}"
			}), "error", 3800);
			try {
				await loadPlugins();
			} catch {}
		} finally {
			setInstallingPlugins((prev) => {
				const next = new Set(prev);
				next.delete(pluginId);
				return next;
			});
		}
	};
	const handleUpdatePlugin = async (pluginId, npmName) => {
		const plugin = plugins.find((candidate) => candidate.id === pluginId);
		const stream = plugin ? getSelectedReleaseStream(plugin) : "alpha";
		setUpdatingPlugins((prev) => new Set(prev).add(pluginId));
		try {
			if ((await runWithPluginManager(npmName, {
				prepare: t("pluginsview.PluginUpdatePreparing", {
					plugin: npmName,
					defaultValue: "Preparing updates for {{plugin}} and restarting the agent..."
				}),
				recover: t("pluginsview.PluginUpdateRecovering", {
					plugin: npmName,
					defaultValue: "Finishing update setup for {{plugin}} and restarting the agent..."
				})
			}, async () => await client.updateRegistryPlugin(npmName, false, { stream }))).requiresRestart) {
				if (!await completePluginLifecycleRestart({
					waiting: t("pluginsview.PluginUpdatedRestarting", {
						plugin: npmName,
						defaultValue: "{{plugin}} updated. Restarting the agent and waiting for activation..."
					}),
					success: t("pluginsview.PluginUpdatedRestartComplete", {
						plugin: npmName,
						defaultValue: "{{plugin}} updated and activated."
					}),
					failure: t("pluginsview.PluginUpdatedRestartFailed", {
						plugin: npmName,
						status: "{{status}}",
						defaultValue: "{{plugin}} updated, but the agent did not come back online (status: {{status}})."
					})
				})) return;
			} else {
				await loadPlugins();
				setActionNotice(t("pluginsview.PluginUpdatedActivated", {
					plugin: npmName,
					defaultValue: "{{plugin}} updated without a full agent restart."
				}), "success");
			}
		} catch (err) {
			setActionNotice(t("pluginsview.PluginUpdateFailed", {
				plugin: npmName,
				message: err instanceof Error ? err.message : "unknown error",
				defaultValue: "Failed to update {{plugin}}: {{message}}"
			}), "error", 3800);
			try {
				await loadPlugins();
			} catch {}
		} finally {
			setUpdatingPlugins((prev) => {
				const next = new Set(prev);
				next.delete(pluginId);
				return next;
			});
		}
	};
	const handleUninstallPlugin = async (pluginId, npmName) => {
		setUninstallingPlugins((prev) => new Set(prev).add(pluginId));
		try {
			if ((await runWithPluginManager(npmName, {
				prepare: t("pluginsview.PluginUninstallPreparing", {
					plugin: npmName,
					defaultValue: "Preparing uninstall for {{plugin}} and restarting the agent..."
				}),
				recover: t("pluginsview.PluginUninstallRecovering", {
					plugin: npmName,
					defaultValue: "Finishing uninstall setup for {{plugin}} and restarting the agent..."
				})
			}, async () => await client.uninstallRegistryPlugin(npmName, false))).requiresRestart) {
				if (!await completePluginLifecycleRestart({
					waiting: t("pluginsview.PluginUninstalledRestarting", {
						plugin: npmName,
						defaultValue: "{{plugin}} uninstalled. Restarting the agent and waiting for cleanup..."
					}),
					success: t("pluginsview.PluginUninstalledRestartComplete", {
						plugin: npmName,
						defaultValue: "{{plugin}} uninstalled and fully unloaded."
					}),
					failure: t("pluginsview.PluginUninstalledRestartFailed", {
						plugin: npmName,
						status: "{{status}}",
						defaultValue: "{{plugin}} uninstalled, but the agent did not come back online (status: {{status}})."
					})
				})) {
					clearPluginReleaseStream(pluginId);
					return;
				}
			} else {
				await loadPlugins();
				setActionNotice(t("pluginsview.PluginUninstalledActivated", {
					plugin: npmName,
					defaultValue: "{{plugin}} uninstalled without a full agent restart."
				}), "success");
			}
			clearPluginReleaseStream(pluginId);
		} catch (err) {
			setActionNotice(t("pluginsview.PluginUninstallFailed", {
				plugin: npmName,
				message: err instanceof Error ? err.message : "unknown error",
				defaultValue: "Failed to uninstall {{plugin}}: {{message}}"
			}), "error", 3800);
			try {
				await loadPlugins();
			} catch {}
		} finally {
			setUninstallingPlugins((prev) => {
				const next = new Set(prev);
				next.delete(pluginId);
				return next;
			});
		}
	};
	const handleTogglePlugin = useCallback(async (pluginId, enabled) => {
		let shouldStart = false;
		setTogglingPlugins((prev) => {
			if (prev.has(pluginId) || prev.size > 0) return prev;
			shouldStart = true;
			return new Set(prev).add(pluginId);
		});
		if (!shouldStart) return;
		try {
			await handlePluginToggle(pluginId, enabled);
		} finally {
			setTogglingPlugins((prev) => {
				const next = new Set(prev);
				next.delete(pluginId);
				return next;
			});
		}
	}, [handlePluginToggle]);
	const handleOpenPluginExternalUrl = useCallback(async (url) => {
		try {
			await openExternalUrl(url);
		} catch (err) {
			setActionNotice(err instanceof Error ? err.message : "Failed to open external link.", "error", 4200);
		}
	}, [setActionNotice]);
	const handleDragStart = useCallback((e, pluginId) => {
		dragRef.current = pluginId;
		setDraggingId(pluginId);
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", pluginId);
	}, []);
	const handleDragOver = useCallback((e, pluginId) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		if (dragRef.current && dragRef.current !== pluginId) setDragOverId(pluginId);
	}, []);
	const handleDrop = useCallback((e, targetId) => {
		e.preventDefault();
		const srcId = dragRef.current;
		if (!srcId || srcId === targetId) {
			dragRef.current = null;
			setDraggingId(null);
			setDragOverId(null);
			return;
		}
		if (!allowCustomOrder) return;
		setPluginOrder(() => {
			const allIds = nonDbPlugins.map((p) => p.id);
			let ids;
			if (pluginOrder.length > 0) {
				const known = new Set(pluginOrder);
				ids = [...pluginOrder, ...allIds.filter((id) => !known.has(id))];
			} else {
				ids = sorted.map((p) => p.id);
				const inSorted = new Set(ids);
				for (const id of allIds) if (!inSorted.has(id)) ids.push(id);
			}
			const fromIdx = ids.indexOf(srcId);
			const toIdx = ids.indexOf(targetId);
			if (fromIdx === -1 || toIdx === -1) return ids;
			ids.splice(fromIdx, 1);
			ids.splice(toIdx, 0, srcId);
			return ids;
		});
		dragRef.current = null;
		setDraggingId(null);
		setDragOverId(null);
	}, [
		allowCustomOrder,
		nonDbPlugins,
		pluginOrder,
		sorted
	]);
	const handleDragEnd = useCallback(() => {
		dragRef.current = null;
		setDraggingId(null);
		setDragOverId(null);
	}, []);
	const handleResetOrder = useCallback(() => {
		setPluginOrder([]);
		localStorage.removeItem("pluginOrder");
	}, []);
	const renderResolvedIcon = useCallback((plugin, options) => {
		const icon = resolveIcon(plugin);
		if (!icon) return (0, import_jsx_runtime.jsx)("span", {
			className: options?.emojiClassName ?? "text-sm",
			children: "🧩"
		});
		if (typeof icon === "string") {
			const imageSrc = iconImageSource(icon);
			return imageSrc ? (0, import_jsx_runtime.jsx)("img", {
				src: imageSrc,
				alt: "",
				className: options?.className ?? "w-5 h-5 rounded-[var(--radius-sm)] object-contain",
				onError: (e) => {
					e.currentTarget.style.display = "none";
				}
			}) : (0, import_jsx_runtime.jsx)("span", {
				className: options?.emojiClassName ?? "text-sm",
				children: icon
			});
		}
		return (0, import_jsx_runtime.jsx)(icon, { className: options?.className ?? "w-5 h-5" });
	}, []);
	/** Render a grid of plugin cards. */
	const renderPluginGrid = (plugins) => (0, import_jsx_runtime.jsx)("ul", {
		className: "grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 m-0 p-0 list-none",
		children: plugins.map((p) => (0, import_jsx_runtime.jsx)(PluginCard, {
			plugin: p,
			allowCustomOrder,
			pluginSettingsOpen,
			togglingPlugins,
			hasPluginToggleInFlight,
			installingPlugins,
			updatingPlugins,
			uninstallingPlugins,
			installProgress,
			releaseStreamSelections: pluginReleaseStreams,
			draggingId,
			dragOverId,
			pluginDescriptionFallback,
			onToggle: handleTogglePlugin,
			onToggleSettings: toggleSettings,
			onInstall: handleInstallPlugin,
			onUpdate: handleUpdatePlugin,
			onUninstall: handleUninstallPlugin,
			onReleaseStreamChange: handleReleaseStreamChange,
			onOpenExternalUrl: handleOpenPluginExternalUrl,
			onDragStart: handleDragStart,
			onDragOver: handleDragOver,
			onDrop: handleDrop,
			onDragEnd: handleDragEnd,
			installProgressLabel,
			installLabel,
			loadFailedLabel,
			notInstalledLabel
		}, p.id))
	});
	const settingsDialogPlugin = Array.from(pluginSettingsOpen).map((id) => nonDbPlugins.find((plugin) => plugin.id === id) ?? null).find((plugin) => (plugin?.parameters?.length ?? 0) > 0) ?? null;
	const [gameSelectedId, setGameSelectedId] = useState(null);
	const [gameMobileDetail, setGameMobileDetail] = useState(false);
	const gameNarrow = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 600px)").matches : false;
	const readDesktopConnectorLayout = () => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1024px)").matches : false;
	const initialDesktopConnectorLayout = readDesktopConnectorLayout();
	const [connectorExpandedIds, setConnectorExpandedIds] = useState(() => /* @__PURE__ */ new Set());
	const [connectorSelectedId, setConnectorSelectedId] = useState(() => isSidebarEditorShellMode && initialDesktopConnectorLayout ? visiblePlugins[0]?.id ?? null : null);
	const [desktopConnectorLayout, setDesktopConnectorLayout] = useState(initialDesktopConnectorLayout);
	const { contentContainerRef: connectorContentRef, queueContentAlignment: queueConnectorContentAlignment, registerContentItem: registerConnectorContentItem, registerRailItem: registerConnectorRailItem, registerSidebarItem: registerConnectorSidebarItem, registerSidebarViewport: registerConnectorSidebarViewport, scrollContentToItem: scrollConnectorIntoView } = useLinkedSidebarSelection({
		contentTopOffset: 0,
		enabled: isSidebarEditorShellMode,
		selectedId: connectorSelectedId,
		topAlignedId: visiblePlugins[0]?.id ?? null
	});
	const gameVisiblePlugins = visiblePlugins.filter((p) => p.id !== "__ui-showcase__");
	const effectiveGameSelected = gameVisiblePlugins.find((p) => p.id === gameSelectedId) ? gameSelectedId : gameVisiblePlugins[0]?.id ?? null;
	const selectedPlugin = gameVisiblePlugins.find((p) => p.id === effectiveGameSelected) ?? null;
	const selectedPluginLinks = selectedPlugin ? getPluginResourceLinks(selectedPlugin, { draftConfig: pluginConfigs[selectedPlugin.id] }) : [];
	useEffect(() => {
		if (!isConnectorShellMode) return;
		if (pluginStatusFilter !== "disabled") return;
		setState("pluginStatusFilter", "all");
	}, [
		isConnectorShellMode,
		pluginStatusFilter,
		setState
	]);
	useEffect(() => {
		if (!isSidebarEditorShellMode) return;
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const media = window.matchMedia("(min-width: 1024px)");
		const syncLayout = () => {
			setDesktopConnectorLayout(media.matches);
		};
		syncLayout();
		if (typeof media.addEventListener === "function") {
			media.addEventListener("change", syncLayout);
			return () => media.removeEventListener("change", syncLayout);
		}
		media.addListener(syncLayout);
		return () => media.removeListener(syncLayout);
	}, [isSidebarEditorShellMode]);
	useEffect(() => {
		if (!isSidebarEditorShellMode) return;
		if (visiblePlugins.length === 0) {
			setConnectorSelectedId(null);
			setConnectorExpandedIds(/* @__PURE__ */ new Set());
			return;
		}
		setConnectorSelectedId((prev) => {
			if (visiblePlugins.some((plugin) => plugin.id === prev)) return prev;
			return desktopConnectorLayout ? visiblePlugins[0]?.id ?? null : null;
		});
		setConnectorExpandedIds((prev) => {
			const next = new Set([...prev].filter((id) => visiblePlugins.some((plugin) => plugin.id === id)));
			if (next.size === prev.size) return prev;
			return next;
		});
	}, [
		desktopConnectorLayout,
		isSidebarEditorShellMode,
		visiblePlugins
	]);
	const handleConnectorSelect = useCallback((pluginId) => {
		setConnectorSelectedId(pluginId);
		if (desktopConnectorLayout) {
			setConnectorExpandedIds(new Set([pluginId]));
			queueConnectorContentAlignment(pluginId);
		} else scrollConnectorIntoView(pluginId);
	}, [
		desktopConnectorLayout,
		queueConnectorContentAlignment,
		scrollConnectorIntoView
	]);
	const handleConnectorExpandedChange = useCallback((pluginId, nextExpanded) => {
		setConnectorSelectedId(pluginId);
		if (desktopConnectorLayout) {
			setConnectorExpandedIds((prev) => {
				if (nextExpanded) {
					if (prev.size === 1 && prev.has(pluginId)) return prev;
					return new Set([pluginId]);
				}
				if (!prev.has(pluginId)) return prev;
				return /* @__PURE__ */ new Set();
			});
			if (nextExpanded) queueConnectorContentAlignment(pluginId);
			return;
		}
		setConnectorExpandedIds((prev) => {
			if (prev.has(pluginId) === nextExpanded) return prev;
			const next = new Set(prev);
			if (nextExpanded) next.add(pluginId);
			else next.delete(pluginId);
			return next;
		});
		if (nextExpanded) scrollConnectorIntoView(pluginId);
	}, [
		desktopConnectorLayout,
		queueConnectorContentAlignment,
		scrollConnectorIntoView
	]);
	const handleConnectorSectionToggle = useCallback((pluginId) => {
		handleConnectorExpandedChange(pluginId, !connectorExpandedIds.has(pluginId));
	}, [connectorExpandedIds, handleConnectorExpandedChange]);
	if (isSidebarEditorShellMode) {
		const shellEmptyTitle = mode === "social" ? "No connectors available" : "No plugins available";
		const shellEmptyDescription = mode === "social" ? "This workspace will list connector integrations as they become available." : "This workspace will list plugins here as they become available.";
		const hasActivePluginFilters = pluginSearch.trim().length > 0 || subgroupFilter !== "all";
		(0, import_jsx_runtime.jsx)(ConnectorSidebar, {
			collapseLabel,
			connectorExpandedIds,
			connectorSelectedId,
			desktopConnectorLayout,
			expandLabel,
			hasPluginToggleInFlight,
			mode,
			onConnectorSelect: handleConnectorSelect,
			onConnectorSectionToggle: handleConnectorSectionToggle,
			onSearchChange: (value) => setState("pluginSearch", value),
			onSearchClear: () => setState("pluginSearch", ""),
			onSubgroupFilterChange: (value) => setSubgroupFilter(value),
			onTogglePlugin: handleTogglePlugin,
			pluginSearch,
			registerConnectorRailItem,
			registerConnectorSidebarItem,
			registerConnectorSidebarViewport,
			renderResolvedIcon,
			resultLabel,
			subgroupFilter,
			subgroupTags,
			t,
			togglingPlugins,
			visiblePlugins
		});
		const connectorContent = (0, import_jsx_runtime.jsxs)("div", {
			className: "w-full",
			children: [hasPluginToggleInFlight && (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
				tone: "accent",
				className: "mb-4 text-xs-tight",
				children: t("pluginsview.ApplyingPluginChan")
			}), visiblePlugins.length === 0 ? (0, import_jsx_runtime.jsx)(PagePanel.Empty, {
				variant: "surface",
				className: "min-h-[18rem] rounded-[1.6rem] px-5 py-10",
				description: hasActivePluginFilters ? `Try a different search or category filter for ${resultLabel}.` : shellEmptyDescription,
				title: hasActivePluginFilters ? `No ${resultLabel} match your filters` : shellEmptyTitle
			}) : (0, import_jsx_runtime.jsx)("div", {
				"data-testid": "connectors-settings-content",
				className: "space-y-1",
				children: (0, import_jsx_runtime.jsx)(ConnectorPluginGroups, {
					collapseLabel,
					connectorExpandedIds,
					connectorInstallPrompt,
					connectorSelectedId,
					expandLabel,
					formatSaveSettingsLabel,
					formatTestConnectionLabel,
					handleConfigReset,
					handleConfigSave,
					handleConnectorExpandedChange,
					handleConnectorSectionToggle,
					handleInstallPlugin,
					handleOpenPluginExternalUrl,
					handleParamChange,
					handleTestConnection,
					handleTogglePlugin,
					hasPluginToggleInFlight,
					installPluginLabel,
					installProgress,
					installProgressLabel,
					installingPlugins,
					loadFailedLabel,
					needsSetupLabel,
					noConfigurationNeededLabel,
					notInstalledLabel,
					pluginConfigs,
					pluginDescriptionFallback,
					pluginSaveSuccess,
					pluginSaving,
					readyLabel,
					registerConnectorContentItem,
					renderResolvedIcon,
					t,
					testResults,
					togglingPlugins,
					visiblePlugins
				})
			})]
		});
		return (0, import_jsx_runtime.jsxs)("main", {
			ref: connectorContentRef,
			className: "chat-native-scrollbar relative flex flex-1 min-w-0 flex-col overflow-x-hidden overflow-y-auto bg-transparent px-4 pb-4 pt-2 sm:px-6 sm:pb-6 sm:pt-3 lg:px-7 lg:pb-7 lg:pt-4",
			children: [contentHeader ? (0, import_jsx_runtime.jsx)(PageLayoutHeader, { children: contentHeader }) : null, connectorContent]
		});
	}
	if (inModal) return (0, import_jsx_runtime.jsx)(PluginGameModal, {
		effectiveGameSelected,
		gameMobileDetail,
		gameNarrow,
		gameVisiblePlugins,
		isConnectorLikeMode,
		pluginConfigs,
		pluginSaveSuccess,
		pluginSaving,
		resultLabel,
		saveLabel,
		savedLabel: savedWithBangLabel,
		savingLabel,
		sectionTitle: mode === "connectors" ? "Connectors" : label,
		selectedPlugin,
		selectedPluginLinks,
		t,
		togglingPlugins,
		onBack: () => setGameMobileDetail(false),
		onConfigSave: handleConfigSave,
		onOpenExternalUrl: handleOpenPluginExternalUrl,
		onParamChange: handleParamChange,
		onSelectPlugin: (pluginId) => {
			setGameSelectedId(pluginId);
			if (gameNarrow) setGameMobileDetail(true);
		},
		onTestConnection: handleTestConnection,
		onTogglePlugin: handleTogglePlugin
	});
	const selectedSubgroupTag = subgroupTags.find((tag) => tag.id === subgroupFilter) ?? subgroupTags[0];
	const pluginSectionTitle = selectedSubgroupTag?.id === "all" ? t("pluginsview.PluginCatalog", { defaultValue: "Plugin Catalog" }) : selectedSubgroupTag?.label ?? t("pluginsview.PluginCatalog", { defaultValue: "Plugin Catalog" });
	return (0, import_jsx_runtime.jsx)(PagePanel.Frame, {
		"data-testid": "plugins-view-page",
		children: (0, import_jsx_runtime.jsxs)(PagePanel, {
			as: "div",
			variant: "shell",
			className: "settings-shell plugins-game-modal plugins-game-modal--inline flex-col lg:flex-row",
			"data-testid": "plugins-shell",
			children: [
				showDesktopSubgroupSidebar && (0, import_jsx_runtime.jsx)(AppPageSidebar, {
					className: "hidden lg:flex",
					testId: "plugins-subgroup-sidebar",
					collapsible: true,
					contentIdentity: "plugins-subgroups",
					"aria-label": t("pluginsview.PluginTypes", { defaultValue: "Plugin types" }),
					collapsedRailItems: subgroupTags.map((tag) => {
						const Icon = SUBGROUP_NAV_ICONS[tag.id] ?? Package;
						const isActive = subgroupFilter === tag.id;
						return (0, import_jsx_runtime.jsx)(SidebarContent.RailItem, {
							"aria-label": tag.label,
							title: tag.label,
							active: isActive,
							onClick: () => setSubgroupFilter(tag.id),
							children: (0, import_jsx_runtime.jsx)(Icon, { className: "h-4 w-4" })
						}, tag.id);
					}),
					children: (0, import_jsx_runtime.jsx)(SidebarScrollRegion, {
						className: "pt-4",
						children: (0, import_jsx_runtime.jsx)(SidebarPanel, { children: subgroupTags.map((tag) => renderSubgroupFilterButton(tag, { sidebar: true })) })
					})
				}),
				(0, import_jsx_runtime.jsx)(PagePanel.ContentArea, { children: (0, import_jsx_runtime.jsx)("div", {
					className: "px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6",
					children: (0, import_jsx_runtime.jsxs)(PagePanel, {
						variant: "section",
						children: [!isConnectorShellMode && (0, import_jsx_runtime.jsx)(PagePanel.Header, {
							eyebrow: t("nav.advanced"),
							heading: pluginSectionTitle,
							className: "border-border/35",
							actions: (0, import_jsx_runtime.jsx)(PagePanel.Meta, {
								className: "border-border/45 px-2.5 py-1 font-bold tracking-[0.16em] text-muted",
								children: t("pluginsview.VisibleCount", {
									defaultValue: "{{count}} shown",
									count: visiblePlugins.length
								})
							})
						}), (0, import_jsx_runtime.jsxs)("div", {
							className: "bg-bg/18 px-4 py-4 sm:px-5",
							children: [
								allowCustomOrder && pluginOrder.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
									className: "mb-4 flex flex-wrap items-center gap-3",
									children: allowCustomOrder && pluginOrder.length > 0 && (0, import_jsx_runtime.jsx)(Button, {
										variant: "outline",
										size: "sm",
										className: "h-9 rounded-[var(--radius-sm)] px-4 text-xs-tight font-bold tracking-[0.12em]",
										onClick: handleResetOrder,
										title: t("pluginsview.ResetToDefaultSor"),
										children: t("pluginsview.ResetOrder")
									})
								}) : null,
								hasPluginToggleInFlight && (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
									tone: "accent",
									className: "mb-4 text-xs-tight",
									children: t("pluginsview.ApplyingPluginChan")
								}),
								showSubgroupFilters && (0, import_jsx_runtime.jsx)("div", {
									className: "mb-5 flex items-center gap-2 flex-wrap lg:hidden",
									"data-testid": "plugins-subgroup-chips",
									children: subgroupTags.map((tag) => renderSubgroupFilterButton(tag))
								}),
								(0, import_jsx_runtime.jsx)("div", {
									className: "overflow-y-auto",
									children: sorted.length === 0 ? (0, import_jsx_runtime.jsx)(PagePanel.Empty, {
										variant: "surface",
										className: "min-h-[18rem] rounded-[1.6rem] px-5 py-10",
										description: t("pluginsview.NoneAvailableDesc", {
											defaultValue: "No {{label}} are available right now.",
											label: resultLabel
										}),
										title: t("pluginsview.NoneAvailableTitle", {
											defaultValue: "No {{label}} available",
											label: label.toLowerCase()
										})
									}) : visiblePlugins.length === 0 ? (0, import_jsx_runtime.jsx)(PagePanel.Empty, {
										variant: "surface",
										className: "min-h-[16rem] rounded-[1.6rem] px-5 py-10",
										description: showSubgroupFilters ? t("pluginsview.NoPluginsMatchCategory", { defaultValue: "No plugins match the selected category." }) : t("pluginsview.NoPluginsMatchFilters", {
											defaultValue: "No {{label}} match your filters.",
											label: resultLabel
										}),
										title: t("pluginsview.NothingToShow", { defaultValue: "Nothing to show" })
									}) : renderPluginGrid(visiblePlugins)
								})
							]
						})]
					})
				}) }),
				(0, import_jsx_runtime.jsx)(PluginSettingsDialog, {
					installPluginLabel,
					installProgress,
					installingPlugins,
					pluginConfigs,
					pluginSaveSuccess,
					pluginSaving,
					settingsDialogPlugin,
					t,
					testResults,
					onClose: toggleSettings,
					onConfigReset: handleConfigReset,
					onConfigSave: handleConfigSave,
					onInstallPlugin: handleInstallPlugin,
					onParamChange: handleParamChange,
					onTestConnection: handleTestConnection,
					formatDialogTestConnectionLabel,
					installProgressLabel,
					saveSettingsLabel,
					savingLabel
				})
			]
		})
	});
}
/** Plugins view — tag-filtered plugin list. */
function PluginsView({ contentHeader, mode = "all", inModal, connectorDesktopPlacement = "left" }) {
	return (0, import_jsx_runtime.jsx)(PluginListView, {
		contentHeader,
		connectorDesktopPlacement,
		label: mode === "social" ? "Connectors" : mode === "connectors" ? "Connectors" : mode === "streaming" ? "Streaming" : mode === "all-social" ? "Plugins" : "Plugins",
		mode,
		inModal
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/ConnectorsPageView.js
/**
* Connectors page — curated connector view.
*/
var ConnectorsPageView_exports = /* @__PURE__ */ __exportAll({ ConnectorsPageView: () => ConnectorsPageView });
function ConnectorsPageView({ inModal, connectorDesktopPlacement } = {}) {
	return (0, import_jsx_runtime.jsx)(PluginsView, {
		mode: "social",
		inModal: inModal ?? false,
		connectorDesktopPlacement
	});
}

//#endregion
export { hasConnectorSetupPanel as a, SignalQrOverlay as c, getBrandIcon as d, ConnectorSetupPanel as i, DiscordLocalConnectorPanel as l, ConnectorsPageView_exports as n, registerConnectorSetupPanel as o, PluginsView as r, WhatsAppQrOverlay as s, ConnectorsPageView as t, BlueBubblesStatusPanel as u };