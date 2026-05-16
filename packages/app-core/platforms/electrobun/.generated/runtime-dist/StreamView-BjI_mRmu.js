import { D as require_jsx_runtime, k as __exportAll, n as isElectrobunRuntime } from "./electrobun-runtime-zXJ9acDW.js";
import { N as getBootConfig, b as isApiError, c as formatUptime, d as client, n as useApp } from "./useApp-Dh-r7aR7.js";
import { Button, useDocumentVisibility } from "@elizaos/ui";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/stream/helpers.js
/** Detect popout mode from URL. */
const IS_POPOUT = (() => {
	if (typeof window === "undefined" || !window.location) return false;
	return new URLSearchParams(window.location.search || window.location.hash?.split("?")[1] || "").has("popout");
})();

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/stream/StatusBar.js
var import_jsx_runtime = require_jsx_runtime();
function StatusBar({ agentName, streamAvailable, streamLive, streamLoading, onToggleStream, uptime, frameCount }) {
	const { t } = useApp();
	const isElectrobun = isElectrobunRuntime();
	const popoutPollRef = useRef(null);
	useEffect(() => {
		return () => {
			if (popoutPollRef.current) {
				clearInterval(popoutPollRef.current);
				popoutPollRef.current = null;
			}
		};
	}, []);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center justify-between bg-card/80 shadow-sm backdrop-blur-xl shrink-0 px-3 py-2 lg:px-4",
		style: IS_POPOUT ? { WebkitAppRegion: "drag" } : void 0,
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-2",
			children: [
				(0, import_jsx_runtime.jsx)("span", { className: `w-2.5 h-2.5 rounded-full ${streamLive ? "bg-danger ring-2 ring-danger/25 animate-pulse" : "bg-muted"}` }),
				(0, import_jsx_runtime.jsx)("span", {
					className: "text-xs font-bold uppercase tracking-wider text-txt",
					children: streamLive ? t("statusbar.LiveShort", { defaultValue: "LIVE" }) : t("statusbar.OfflineShort", { defaultValue: "OFFLINE" })
				}),
				(0, import_jsx_runtime.jsx)("span", {
					className: "text-sm font-semibold text-txt-strong",
					children: agentName
				})
			]
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-2 lg:gap-3 text-xs text-muted",
			style: IS_POPOUT ? { WebkitAppRegion: "no-drag" } : void 0,
			children: [
				streamLive && (0, import_jsx_runtime.jsxs)("span", {
					className: "inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-border/45 bg-card/92 px-2.5 py-1.5 text-xs-tight text-muted-strong shadow-sm font-mono text-2xs",
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: "text-txt",
							children: formatUptime(uptime)
						}),
						(0, import_jsx_runtime.jsx)("span", {
							className: "text-border",
							children: "|"
						}),
						(0, import_jsx_runtime.jsxs)("span", {
							className: "text-txt",
							children: [frameCount.toLocaleString(), "f"]
						})
					]
				}),
				(0, import_jsx_runtime.jsx)(Button, {
					size: "sm",
					disabled: !streamAvailable || streamLoading,
					className: `inline-flex h-9 min-h-9 items-center justify-center rounded-xl border px-3 text-xs-tight font-semibold uppercase tracking-[0.16em] shadow-sm transition-[border-color,background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-wait disabled:opacity-50 ${streamLive ? "border-danger/35 bg-danger/10 text-danger hover:border-danger/50 hover:bg-danger/16" : "border-ok/35 bg-ok/10 text-ok hover:border-ok/50 hover:bg-ok/16"}`,
					onClick: onToggleStream,
					title: streamAvailable ? void 0 : t("statusbar.InstallStreamingPlugin", { defaultValue: "Install and enable the streaming plugin to go live" }),
					children: streamLoading ? "..." : streamLive ? t("statusbar.StopStream", { defaultValue: "Stop Stream" }) : t("statusbar.GoLive", { defaultValue: "Go Live" })
				}),
				!IS_POPOUT && !isElectrobun && (0, import_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					className: "inline-flex min-h-9 h-9 w-9 items-center justify-center rounded-xl border border-border/45 bg-card/92 px-0 py-1.5 text-xs-tight text-muted-strong shadow-sm transition-[border-color,background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent/35 hover:border-border-strong hover:bg-bg-hover hover:text-txt hover:shadow-md",
					title: t("statusbar.PopOutStreamView"),
					onClick: () => {
						const apiBase = getBootConfig().apiBase;
						const base = window.location.origin || "";
						const sep = window.location.protocol === "file:" || window.location.protocol === "electrobun:" ? "#" : "";
						const qs = apiBase ? `popout&apiBase=${encodeURIComponent(apiBase)}` : "popout";
						const popoutWin = window.open(`${base}${sep}/?${qs}`, "elizaos-stream", "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no");
						if (popoutWin) {
							window.dispatchEvent(new CustomEvent("stream-popout", { detail: "opened" }));
							if (popoutPollRef.current) clearInterval(popoutPollRef.current);
							popoutPollRef.current = setInterval(() => {
								if (popoutWin.closed) {
									if (popoutPollRef.current) {
										clearInterval(popoutPollRef.current);
										popoutPollRef.current = null;
									}
									window.dispatchEvent(new CustomEvent("stream-popout", { detail: "closed" }));
								}
							}, 500);
						}
					},
					children: (0, import_jsx_runtime.jsx)(ExternalLink, { className: "w-3.5 h-3.5" })
				})
			]
		})]
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/StreamView.js
var StreamView_exports = /* @__PURE__ */ __exportAll({ StreamView: () => StreamView });
function StreamView({ inModal } = {}) {
	const { agentStatus, t } = useApp();
	const { branding } = getBootConfig();
	const agentName = agentStatus?.agentName ?? branding.appName ?? "Eliza";
	const isElectrobun = isElectrobunRuntime();
	const [streamLive, setStreamLive] = useState(false);
	const [streamLoading, setStreamLoading] = useState(false);
	const loadingRef = useRef(false);
	const docVisible = useDocumentVisibility();
	const [streamAvailable, setStreamAvailable] = useState(true);
	const [uptime, setUptime] = useState(0);
	const [frameCount, setFrameCount] = useState(0);
	useEffect(() => {
		let mounted = true;
		const poll = async () => {
			if (loadingRef.current || !streamAvailable) return;
			try {
				const status = await client.streamStatus();
				if (mounted && !loadingRef.current) {
					setStreamLive(status.running && status.ffmpegAlive);
					setUptime(status.uptime);
					setFrameCount(status.frameCount);
				}
			} catch (err) {
				if (isApiError(err) && err.status === 404) {
					setStreamAvailable(false);
					return;
				}
			}
		};
		if (!streamAvailable || !docVisible) return;
		poll();
		const id = setInterval(poll, 5e3);
		return () => {
			mounted = false;
			clearInterval(id);
		};
	}, [streamAvailable, docVisible]);
	const toggleStream = useCallback(async () => {
		if (loadingRef.current) return;
		loadingRef.current = true;
		setStreamLoading(true);
		try {
			if (streamLive) {
				await client.streamGoOffline();
				setStreamLive(false);
			} else {
				const result = await client.streamGoLive();
				setStreamLive(result.live);
				if (result.live && !IS_POPOUT && !isElectrobun) {
					const apiBase = getBootConfig().apiBase;
					const base = window.location.origin || "";
					const sep = window.location.protocol === "file:" || window.location.protocol === "electrobun:" ? "#" : "";
					const qs = apiBase ? `popout&apiBase=${encodeURIComponent(apiBase)}` : "popout";
					window.open(`${base}${sep}/?${qs}`, "elizaos-stream", "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no");
				}
			}
		} catch (err) {
			console.warn("[stream] Failed to toggle stream:", err);
			try {
				const status = await client.streamStatus();
				setStreamLive(status.running && status.ffmpegAlive);
			} catch {}
		} finally {
			loadingRef.current = false;
			setStreamLoading(false);
		}
	}, [isElectrobun, streamLive]);
	return (0, import_jsx_runtime.jsxs)("div", {
		"data-stream-view": true,
		className: `flex flex-col text-txt font-body ${inModal ? "bg-transparent" : "bg-bg"} h-full w-full`,
		children: [(0, import_jsx_runtime.jsx)(StatusBar, {
			agentName,
			streamAvailable,
			streamLive,
			streamLoading,
			onToggleStream: toggleStream,
			uptime,
			frameCount
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "flex flex-1 min-h-0 items-center justify-center",
			children: !streamAvailable ? (0, import_jsx_runtime.jsxs)("div", {
				className: "max-w-lg rounded-3xl border border-border/60 bg-card/94 p-6 text-center shadow-xl backdrop-blur-xl",
				children: [
					(0, import_jsx_runtime.jsx)("p", {
						className: "text-xs-tight uppercase tracking-[0.24em] text-muted",
						children: t("streamview.StreamingUnavailabl")
					}),
					(0, import_jsx_runtime.jsx)("h2", {
						className: "mt-2 text-xl font-semibold text-txt",
						children: t("streamview.EnableTheStreaming")
					}),
					(0, import_jsx_runtime.jsxs)("p", {
						className: "mt-3 text-sm leading-6 text-muted",
						children: [
							t("streamview.CouldNotRea"),
							" ",
							(0, import_jsx_runtime.jsx)("code", {
								className: "rounded-md border border-border/45 bg-bg-hover px-1.5 py-0.5 text-xs text-txt-strong",
								children: t("streamview.streamingBase")
							}),
							" ",
							t("streamview.pluginThenReload")
						]
					}),
					(0, import_jsx_runtime.jsx)("p", {
						className: "mt-4 text-xs text-muted",
						children: t("streamview.IfThePluginIsAlr")
					})
				]
			}) : (0, import_jsx_runtime.jsxs)("div", {
				className: "max-w-md rounded-3xl border border-border/60 bg-card/94 p-6 text-center shadow-xl backdrop-blur-xl",
				children: [
					(0, import_jsx_runtime.jsx)("div", { className: `mx-auto mb-4 h-3 w-3 rounded-full ${streamLive ? "bg-danger ring-4 ring-danger/20 animate-pulse" : "bg-muted"}` }),
					(0, import_jsx_runtime.jsx)("h2", {
						className: "text-lg font-semibold text-txt",
						children: streamLive ? t("streamview.StreamIsLive", { defaultValue: "Stream is Live" }) : t("streamview.StreamReady", { defaultValue: "Stream Ready" })
					}),
					(0, import_jsx_runtime.jsx)("p", {
						className: "mt-2 text-sm text-muted",
						children: streamLive ? t("streamview.StreamLiveStatus", {
							uptime: formatUptime(uptime),
							frameCount: frameCount.toLocaleString(),
							defaultValue: "Uptime: {{uptime}} · {{frameCount}} frames"
						}) : t("streamview.GoLiveHint", { defaultValue: "Press Go Live to start streaming." })
					})
				]
			})
		})]
	});
}

//#endregion
export { StreamView_exports as n, StreamView as t };