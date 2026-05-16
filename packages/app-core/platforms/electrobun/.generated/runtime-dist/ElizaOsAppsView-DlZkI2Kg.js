import { D as require_jsx_runtime } from "./electrobun-runtime-zXJ9acDW.js";
import { getPlugins } from "./index.js";
import { Clock3, ContactRound, FileUp, MessageSquare, NotebookText, PhoneCall, Plus, RefreshCw, Search, Send, Settings, ShieldCheck, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/ElizaOsAppsView.js
var import_jsx_runtime = require_jsx_runtime();
const PHONE_PANEL_ITEMS = [
	{
		id: "dialer",
		label: "Dialer",
		icon: (0, import_jsx_runtime.jsx)(PhoneCall, { className: "h-4 w-4" })
	},
	{
		id: "recents",
		label: "Recents",
		icon: (0, import_jsx_runtime.jsx)(Clock3, { className: "h-4 w-4" })
	},
	{
		id: "contacts",
		label: "Contacts",
		icon: (0, import_jsx_runtime.jsx)(ContactRound, { className: "h-4 w-4" })
	},
	{
		id: "import",
		label: "Import",
		icon: (0, import_jsx_runtime.jsx)(FileUp, { className: "h-4 w-4" })
	},
	{
		id: "transcripts",
		label: "Transcripts",
		icon: (0, import_jsx_runtime.jsx)(NotebookText, { className: "h-4 w-4" })
	}
];
const DIALPAD_KEYS = [
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"*",
	"0",
	"#"
];
function useLaunchParams() {
	const [params, setParams] = useState(() => readLaunchParams());
	useEffect(() => {
		const onHashChange = () => setParams(readLaunchParams());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);
	return params;
}
function readLaunchParams() {
	if (typeof window === "undefined") return new URLSearchParams();
	return new URLSearchParams(window.location.hash.split("?")[1] ?? "");
}
function Panel({ title, description, children }) {
	return (0, import_jsx_runtime.jsxs)("section", {
		className: "rounded border border-border bg-card p-4 shadow-sm",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "mb-4",
			children: [(0, import_jsx_runtime.jsx)("h2", {
				className: "text-base font-semibold text-txt",
				children: title
			}), description ? (0, import_jsx_runtime.jsx)("p", {
				className: "mt-1 text-sm text-muted",
				children: description
			}) : null]
		}), children]
	});
}
function PrimaryButton({ children, disabled, icon, onClick, type = "button" }) {
	return (0, import_jsx_runtime.jsxs)("button", {
		type,
		disabled,
		onClick,
		className: "inline-flex h-9 items-center justify-center gap-2 rounded border border-border bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50",
		children: [icon, (0, import_jsx_runtime.jsx)("span", {
			className: "truncate",
			children
		})]
	});
}
function SecondaryButton({ children, disabled, icon, onClick, type = "button" }) {
	return (0, import_jsx_runtime.jsxs)("button", {
		type,
		disabled,
		onClick,
		className: "inline-flex h-9 items-center justify-center gap-2 rounded border border-border bg-bg px-3 text-sm font-medium text-txt disabled:cursor-not-allowed disabled:opacity-50",
		children: [icon, (0, import_jsx_runtime.jsx)("span", {
			className: "truncate",
			children
		})]
	});
}
function TextInput({ label, onChange, placeholder, value }) {
	return (0, import_jsx_runtime.jsxs)("label", {
		className: "grid gap-1 text-sm text-txt",
		children: [(0, import_jsx_runtime.jsx)("span", {
			className: "font-medium",
			children: label
		}), (0, import_jsx_runtime.jsx)("input", {
			value,
			placeholder,
			onChange: (event) => onChange(event.target.value),
			className: "h-10 rounded border border-border bg-bg px-3 text-sm text-txt outline-none focus:border-primary"
		})]
	});
}
function TextArea({ label, onChange, placeholder, value }) {
	return (0, import_jsx_runtime.jsxs)("label", {
		className: "grid gap-1 text-sm text-txt",
		children: [(0, import_jsx_runtime.jsx)("span", {
			className: "font-medium",
			children: label
		}), (0, import_jsx_runtime.jsx)("textarea", {
			value,
			placeholder,
			onChange: (event) => onChange(event.target.value),
			className: "min-h-24 rounded border border-border bg-bg px-3 py-2 text-sm text-txt outline-none focus:border-primary"
		})]
	});
}
function StatusNotice({ error, notice }) {
	if (error) return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive",
		children: error
	});
	if (notice) return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded border border-border bg-bg px-3 py-2 text-sm text-muted",
		children: notice
	});
	return null;
}
function EmptyState({ children }) {
	return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded border border-border bg-bg p-3 text-sm text-muted",
		children
	});
}
function roleHolderText(role) {
	return role.holders.length > 0 ? role.holders.join(", ") : "none";
}
function numberFromTelUri(uri) {
	if (!uri) return "";
	if (!uri.startsWith("tel:")) return uri;
	return decodeURIComponent(uri.slice(4));
}
function primaryPhoneNumber(contact) {
	return contact.phoneNumbers[0] ?? "";
}
function callDisplayName(call) {
	return call.cachedName || call.number || "Unknown caller";
}
function callTypeLabel(type) {
	switch (type) {
		case "incoming": return "Incoming";
		case "outgoing": return "Outgoing";
		case "missed": return "Missed";
		case "voicemail": return "Voicemail";
		case "rejected": return "Rejected";
		case "blocked": return "Blocked";
		case "answered_externally": return "Answered elsewhere";
		default: return "Unknown";
	}
}
function durationLabel(seconds) {
	if (seconds <= 0) return "0s";
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
function formatTimestamp(timestamp) {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown time";
	return new Date(timestamp).toLocaleString();
}
function openMessagesForNumber(number) {
	if (!number) return;
	window.location.hash = `#messages?recipient=${encodeURIComponent(number)}`;
}
function PhonePageView() {
	const params = useLaunchParams();
	const fileInputRef = useRef(null);
	const [activePanel, setActivePanel] = useState("dialer");
	const [number, setNumber] = useState(() => {
		return params.get("number") ?? numberFromTelUri(params.get("uri"));
	});
	const [contactQuery, setContactQuery] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [phoneNumber, setPhoneNumber] = useState("");
	const [emailAddress, setEmailAddress] = useState("");
	const [vcardText, setVcardText] = useState("");
	const [status, setStatus] = useState([]);
	const [roles, setRoles] = useState([]);
	const [calls, setCalls] = useState([]);
	const [contacts, setContacts] = useState([]);
	const [selectedCallId, setSelectedCallId] = useState(null);
	const [transcriptDraft, setTranscriptDraft] = useState("");
	const [summaryDraft, setSummaryDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(() => {
		const event = params.get("event");
		const launchNumber = params.get("number") ?? numberFromTelUri(params.get("uri"));
		if (!event) return null;
		return launchNumber ? `${event}: ${launchNumber}` : event;
	});
	const [error, setError] = useState(null);
	const selectedCall = useMemo(() => calls.find((call) => call.id === selectedCallId) ?? calls[0] ?? null, [calls, selectedCallId]);
	const contactListOptions = useMemo(() => ({
		limit: 200,
		query: contactQuery.trim() || void 0
	}), [contactQuery]);
	useEffect(() => {
		const launchNumber = params.get("number") ?? numberFromTelUri(params.get("uri"));
		if (launchNumber) setNumber(launchNumber);
		const event = params.get("event");
		if (event) {
			setNotice(launchNumber ? `${event}: ${launchNumber}` : event);
			setActivePanel("dialer");
		}
	}, [params]);
	useEffect(() => {
		if (!selectedCall) {
			setTranscriptDraft("");
			setSummaryDraft("");
			return;
		}
		setTranscriptDraft(selectedCall.agentTranscript ?? selectedCall.transcription ?? "");
		setSummaryDraft(selectedCall.agentSummary ?? "");
	}, [selectedCall]);
	const refresh = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const plugins = getPlugins();
			if (typeof plugins.phone.plugin.getStatus !== "function") throw new Error("ElizaPhone plugin is unavailable");
			if (typeof plugins.phone.plugin.listRecentCalls !== "function") throw new Error("ElizaPhone call log API is unavailable");
			if (typeof plugins.system.plugin.getStatus !== "function") throw new Error("ElizaSystem plugin is unavailable");
			if (typeof plugins.contacts.plugin.listContacts !== "function") throw new Error("ElizaContacts plugin is unavailable");
			const [phone, system, recentCalls, contactResult] = await Promise.all([
				plugins.phone.plugin.getStatus(),
				plugins.system.plugin.getStatus(),
				plugins.phone.plugin.listRecentCalls({ limit: 100 }),
				plugins.contacts.plugin.listContacts(contactListOptions)
			]);
			setStatus([
				`telecom: ${phone.hasTelecom ? "available" : "unavailable"}`,
				`default dialer: ${phone.defaultDialerPackage ?? "none"}`,
				`eliza default dialer: ${phone.isDefaultDialer ? "yes" : "no"}`,
				`can place calls: ${phone.canPlaceCalls ? "yes" : "no"}`
			]);
			setRoles(system.roles);
			setCalls(recentCalls.calls);
			setContacts(contactResult.contacts);
			setSelectedCallId((current) => current ?? recentCalls.calls[0]?.id ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [contactListOptions]);
	useEffect(() => {
		refresh();
	}, [refresh]);
	const appendDialpadKey = (key) => setNumber((current) => `${current}${key}`);
	const placeCall = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const trimmed = number.trim();
			if (!trimmed) throw new Error("number is required");
			const plugins = getPlugins();
			if (typeof plugins.phone.plugin.placeCall !== "function") throw new Error("ElizaPhone plugin is unavailable");
			await plugins.phone.plugin.placeCall({ number: trimmed });
			setNotice("Call request handed to Android Telecom.");
			setActivePanel("recents");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const openDialer = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const plugins = getPlugins();
			if (typeof plugins.phone.plugin.openDialer !== "function") throw new Error("ElizaPhone plugin is unavailable");
			await plugins.phone.plugin.openDialer({ number: number.trim() || void 0 });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const createContact = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const name = displayName.trim();
			const nextPhoneNumber = phoneNumber.trim();
			const nextEmailAddress = emailAddress.trim();
			if (!name) throw new Error("displayName is required");
			const plugins = getPlugins();
			if (typeof plugins.contacts.plugin.createContact !== "function") throw new Error("ElizaContacts plugin is unavailable");
			setNotice(`Created contact ${(await plugins.contacts.plugin.createContact({
				displayName: name,
				phoneNumber: nextPhoneNumber || void 0,
				emailAddress: nextEmailAddress || void 0
			})).id}.`);
			setDisplayName("");
			setPhoneNumber("");
			setEmailAddress("");
			await refresh();
			setActivePanel("contacts");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const importVCardText = async (text) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const plugins = getPlugins();
			if (typeof plugins.contacts.plugin.importVCard !== "function") throw new Error("ElizaContacts import API is unavailable");
			setNotice(`Imported ${(await plugins.contacts.plugin.importVCard({ vcardText: text })).imported.length} contact(s).`);
			setVcardText("");
			await refresh();
			setActivePanel("contacts");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const importSelectedFile = async (event) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		await importVCardText(await file.text());
	};
	const saveTranscript = async () => {
		if (!selectedCall) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const transcript = transcriptDraft.trim();
			if (!transcript) throw new Error("transcript is required");
			const plugins = getPlugins();
			if (typeof plugins.phone.plugin.saveCallTranscript !== "function") throw new Error("ElizaPhone transcript API is unavailable");
			await plugins.phone.plugin.saveCallTranscript({
				callId: selectedCall.id,
				transcript,
				summary: summaryDraft.trim() || void 0
			});
			setNotice("Transcript saved.");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const requestAndroidRole = async (role) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			if (!role.available) throw new Error(`${role.androidRole} is not available on this device`);
			const plugins = getPlugins();
			if (typeof plugins.system.plugin.requestRole !== "function") throw new Error("ElizaSystem role request API is unavailable");
			const result = await plugins.system.plugin.requestRole({ role: role.role });
			setNotice(`${role.role} role ${result.held ? "is held by Eliza" : "was not granted"}.`);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const openSystemSettings = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const plugins = getPlugins();
			if (typeof plugins.system.plugin.openSettings !== "function") throw new Error("ElizaSystem settings API is unavailable");
			await plugins.system.plugin.openSettings();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const renderPanel = () => {
		if (activePanel === "recents") return (0, import_jsx_runtime.jsxs)(Panel, {
			title: "Recent Calls",
			description: "Android call log entries.",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "mb-3 flex flex-wrap gap-2",
				children: (0, import_jsx_runtime.jsx)(SecondaryButton, {
					disabled: busy,
					icon: (0, import_jsx_runtime.jsx)(RefreshCw, { className: "h-4 w-4" }),
					onClick: refresh,
					children: "Refresh"
				})
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "grid max-h-[62vh] gap-2 overflow-y-auto",
				children: calls.length > 0 ? calls.map((call) => (0, import_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: () => {
						setSelectedCallId(call.id);
						setActivePanel("transcripts");
					},
					className: "rounded border border-border bg-bg p-3 text-left text-sm hover:border-primary",
					children: [
						(0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-wrap items-center justify-between gap-2",
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: "font-medium text-txt",
								children: callDisplayName(call)
							}), (0, import_jsx_runtime.jsxs)("span", {
								className: "text-xs text-muted",
								children: [
									callTypeLabel(call.type),
									" ·",
									" ",
									durationLabel(call.durationSeconds)
								]
							})]
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted",
							children: [(0, import_jsx_runtime.jsx)("span", { children: call.number || "unknown number" }), (0, import_jsx_runtime.jsx)("span", { children: formatTimestamp(call.date) })]
						}),
						call.agentTranscript || call.transcription ? (0, import_jsx_runtime.jsx)("div", {
							className: "mt-2 line-clamp-2 text-xs text-muted",
							children: call.agentSummary || call.agentTranscript || call.transcription
						}) : null
					]
				}, call.id)) : (0, import_jsx_runtime.jsx)(EmptyState, { children: "No calls returned by Android." })
			})]
		});
		if (activePanel === "contacts") return (0, import_jsx_runtime.jsxs)(Panel, {
			title: "Contacts",
			description: "Android Contacts Provider.",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "mb-3 grid gap-3 sm:grid-cols-[1fr_auto]",
				children: [(0, import_jsx_runtime.jsx)(TextInput, {
					label: "Search",
					placeholder: "Name, number, or email",
					value: contactQuery,
					onChange: setContactQuery
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "flex items-end",
					children: (0, import_jsx_runtime.jsx)(SecondaryButton, {
						disabled: busy,
						icon: (0, import_jsx_runtime.jsx)(Search, { className: "h-4 w-4" }),
						onClick: refresh,
						children: "Search"
					})
				})]
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "grid max-h-[62vh] gap-2 overflow-y-auto",
				children: contacts.length > 0 ? contacts.map((contact) => {
					const contactNumber = primaryPhoneNumber(contact);
					return (0, import_jsx_runtime.jsx)("div", {
						className: "rounded border border-border bg-bg p-3 text-sm",
						children: (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-wrap items-start justify-between gap-3",
							children: [(0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0",
								children: [
									(0, import_jsx_runtime.jsx)("div", {
										className: "font-medium text-txt",
										children: contact.displayName || "Unnamed contact"
									}),
									(0, import_jsx_runtime.jsx)("div", {
										className: "mt-1 text-muted",
										children: contact.phoneNumbers.length > 0 ? contact.phoneNumbers.join(", ") : "No phone numbers"
									}),
									contact.emailAddresses.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
										className: "mt-1 text-xs text-muted",
										children: contact.emailAddresses.join(", ")
									}) : null
								]
							}), (0, import_jsx_runtime.jsxs)("div", {
								className: "flex flex-wrap gap-2",
								children: [(0, import_jsx_runtime.jsx)(SecondaryButton, {
									disabled: !contactNumber,
									icon: (0, import_jsx_runtime.jsx)(PhoneCall, { className: "h-4 w-4" }),
									onClick: () => {
										setNumber(contactNumber);
										setActivePanel("dialer");
									},
									children: "Dial"
								}), (0, import_jsx_runtime.jsx)(SecondaryButton, {
									disabled: !contactNumber,
									icon: (0, import_jsx_runtime.jsx)(MessageSquare, { className: "h-4 w-4" }),
									onClick: () => openMessagesForNumber(contactNumber),
									children: "SMS"
								})]
							})]
						})
					}, contact.id);
				}) : (0, import_jsx_runtime.jsx)(EmptyState, { children: "No contacts returned by Android." })
			})]
		});
		if (activePanel === "import") return (0, import_jsx_runtime.jsx)(Panel, {
			title: "Import Contacts",
			description: "vCard contacts import.",
			children: (0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-3",
				children: [
					(0, import_jsx_runtime.jsx)("input", {
						ref: fileInputRef,
						type: "file",
						accept: ".vcf,text/vcard,text/x-vcard",
						className: "hidden",
						onChange: importSelectedFile
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-wrap gap-2",
						children: [(0, import_jsx_runtime.jsx)(PrimaryButton, {
							disabled: busy,
							icon: (0, import_jsx_runtime.jsx)(FileUp, { className: "h-4 w-4" }),
							onClick: () => fileInputRef.current?.click(),
							children: "Choose vCard"
						}), (0, import_jsx_runtime.jsx)(SecondaryButton, {
							disabled: busy || !vcardText.trim(),
							icon: (0, import_jsx_runtime.jsx)(Plus, { className: "h-4 w-4" }),
							onClick: () => importVCardText(vcardText),
							children: "Import Text"
						})]
					}),
					(0, import_jsx_runtime.jsx)(TextArea, {
						label: "vCard Text",
						placeholder: "BEGIN:VCARD",
						value: vcardText,
						onChange: setVcardText
					})
				]
			})
		});
		if (activePanel === "transcripts") return (0, import_jsx_runtime.jsx)(Panel, {
			title: "Call Transcript",
			description: "Call log transcription and agent notes.",
			children: selectedCall ? (0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-3",
				children: [
					(0, import_jsx_runtime.jsxs)("div", {
						className: "rounded border border-border bg-bg p-3 text-sm",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "font-medium text-txt",
							children: callDisplayName(selectedCall)
						}), (0, import_jsx_runtime.jsxs)("div", {
							className: "mt-1 text-xs text-muted",
							children: [
								selectedCall.number || "unknown number",
								" ·",
								" ",
								callTypeLabel(selectedCall.type),
								" ·",
								" ",
								formatTimestamp(selectedCall.date)
							]
						})]
					}),
					selectedCall.transcription ? (0, import_jsx_runtime.jsxs)("div", {
						className: "rounded border border-border bg-bg p-3 text-sm text-txt",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "mb-1 text-xs font-medium uppercase text-muted",
							children: "Voicemail transcription"
						}), selectedCall.transcription]
					}) : null,
					(0, import_jsx_runtime.jsx)(TextArea, {
						label: "Agent Transcript",
						value: transcriptDraft,
						onChange: setTranscriptDraft
					}),
					(0, import_jsx_runtime.jsx)(TextInput, {
						label: "Agent Summary",
						value: summaryDraft,
						onChange: setSummaryDraft
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-wrap gap-2",
						children: [(0, import_jsx_runtime.jsx)(PrimaryButton, {
							disabled: busy || !transcriptDraft.trim(),
							icon: (0, import_jsx_runtime.jsx)(NotebookText, { className: "h-4 w-4" }),
							onClick: saveTranscript,
							children: "Save Transcript"
						}), (0, import_jsx_runtime.jsx)(SecondaryButton, {
							disabled: !selectedCall.number,
							icon: (0, import_jsx_runtime.jsx)(MessageSquare, { className: "h-4 w-4" }),
							onClick: () => openMessagesForNumber(selectedCall.number),
							children: "Reply SMS"
						})]
					})
				]
			}) : (0, import_jsx_runtime.jsx)(EmptyState, { children: "No call selected." })
		});
		return (0, import_jsx_runtime.jsx)(Panel, {
			title: "Dialer",
			description: "Android Telecom calling surface.",
			children: (0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-4 lg:grid-cols-[minmax(240px,320px)_1fr]",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "grid gap-3",
					children: [
						(0, import_jsx_runtime.jsx)(TextInput, {
							label: "Number",
							placeholder: "+15551234567",
							value: number,
							onChange: setNumber
						}),
						(0, import_jsx_runtime.jsx)("div", {
							className: "grid grid-cols-3 gap-2",
							children: DIALPAD_KEYS.map((key) => (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => appendDialpadKey(key),
								className: "aspect-[1.6] rounded border border-border bg-bg text-lg font-semibold text-txt hover:border-primary",
								children: key
							}, key))
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-wrap gap-2",
							children: [
								(0, import_jsx_runtime.jsx)(PrimaryButton, {
									disabled: busy || !number.trim(),
									icon: (0, import_jsx_runtime.jsx)(PhoneCall, { className: "h-4 w-4" }),
									onClick: placeCall,
									children: "Call"
								}),
								(0, import_jsx_runtime.jsx)(SecondaryButton, {
									disabled: busy,
									icon: (0, import_jsx_runtime.jsx)(PhoneCall, { className: "h-4 w-4" }),
									onClick: openDialer,
									children: "Open Dialer"
								}),
								(0, import_jsx_runtime.jsx)(SecondaryButton, {
									disabled: !number.trim(),
									icon: (0, import_jsx_runtime.jsx)(MessageSquare, { className: "h-4 w-4" }),
									onClick: () => openMessagesForNumber(number.trim()),
									children: "SMS"
								})
							]
						})
					]
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "grid gap-3",
					children: [
						(0, import_jsx_runtime.jsx)("div", {
							className: "grid gap-1 rounded border border-border bg-bg p-3 text-sm text-muted",
							children: status.length > 0 ? status.map((line) => (0, import_jsx_runtime.jsx)("div", { children: line }, line)) : "No status loaded."
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "grid gap-2 rounded border border-border bg-bg p-3",
							children: [
								(0, import_jsx_runtime.jsx)("div", {
									className: "text-sm font-medium text-txt",
									children: "Android default roles"
								}),
								roles.length > 0 ? roles.map((role) => (0, import_jsx_runtime.jsxs)("div", {
									className: "flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-card p-2 text-sm",
									children: [(0, import_jsx_runtime.jsxs)("div", {
										className: "min-w-0",
										children: [(0, import_jsx_runtime.jsxs)("div", {
											className: "font-medium text-txt",
											children: [
												role.role,
												": ",
												role.held ? "held" : "not held"
											]
										}), (0, import_jsx_runtime.jsxs)("div", {
											className: "truncate text-xs text-muted",
											children: ["holders: ", roleHolderText(role)]
										})]
									}), (0, import_jsx_runtime.jsx)(SecondaryButton, {
										disabled: busy || !role.available || role.held,
										icon: (0, import_jsx_runtime.jsx)(ShieldCheck, { className: "h-4 w-4" }),
										onClick: () => requestAndroidRole(role),
										children: "Request"
									})]
								}, role.role)) : (0, import_jsx_runtime.jsx)(EmptyState, { children: "No Android roles returned." }),
								(0, import_jsx_runtime.jsx)(SecondaryButton, {
									disabled: busy,
									icon: (0, import_jsx_runtime.jsx)(Settings, { className: "h-4 w-4" }),
									onClick: openSystemSettings,
									children: "Settings"
								})
							]
						}),
						(0, import_jsx_runtime.jsxs)("div", {
							className: "rounded border border-border bg-bg p-3",
							children: [(0, import_jsx_runtime.jsx)("div", {
								className: "mb-3 text-sm font-medium text-txt",
								children: "New Contact"
							}), (0, import_jsx_runtime.jsxs)("div", {
								className: "grid gap-3",
								children: [
									(0, import_jsx_runtime.jsx)(TextInput, {
										label: "Display Name",
										value: displayName,
										onChange: setDisplayName
									}),
									(0, import_jsx_runtime.jsx)(TextInput, {
										label: "Phone Number",
										value: phoneNumber,
										onChange: setPhoneNumber
									}),
									(0, import_jsx_runtime.jsx)(TextInput, {
										label: "Email",
										value: emailAddress,
										onChange: setEmailAddress
									}),
									(0, import_jsx_runtime.jsx)(PrimaryButton, {
										disabled: busy || !displayName.trim(),
										icon: (0, import_jsx_runtime.jsx)(UserPlus, { className: "h-4 w-4" }),
										onClick: createContact,
										children: "Create Contact"
									})
								]
							})]
						})
					]
				})]
			})
		});
	};
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-full min-h-0 w-full flex-col gap-4 p-4",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center justify-between gap-3",
				children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)("h1", {
					className: "text-lg font-semibold text-txt",
					children: "Phone"
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "text-sm text-muted",
					children: "ElizaOS Android phone workspace"
				})] }), (0, import_jsx_runtime.jsx)(SecondaryButton, {
					disabled: busy,
					icon: (0, import_jsx_runtime.jsx)(RefreshCw, { className: "h-4 w-4" }),
					onClick: refresh,
					children: "Refresh"
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-wrap gap-2",
				children: PHONE_PANEL_ITEMS.map((item) => (0, import_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: () => setActivePanel(item.id),
					className: `inline-flex h-9 items-center gap-2 rounded border px-3 text-sm font-medium ${activePanel === item.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-bg text-txt"}`,
					children: [item.icon, (0, import_jsx_runtime.jsx)("span", { children: item.label })]
				}, item.id))
			}),
			(0, import_jsx_runtime.jsx)(StatusNotice, {
				error,
				notice
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "min-h-0 flex-1 overflow-y-auto",
				children: renderPanel()
			})
		]
	});
}
function messageTypeLabel(type) {
	if (type === 1) return "inbox";
	if (type === 2) return "sent";
	if (type === 3) return "draft";
	if (type === 4) return "outbox";
	if (type === 5) return "failed";
	if (type === 6) return "queued";
	return `type ${type}`;
}
function readIncomingSmsContext(params) {
	if (params.get("event") !== "sms-deliver") return null;
	const sender = params.get("sender") ?? "";
	const body = params.get("body") ?? "";
	const rawTimestamp = Number(params.get("timestamp"));
	if (!sender && !body) return null;
	return {
		sender,
		body,
		timestamp: Number.isFinite(rawTimestamp) ? rawTimestamp : null,
		messageId: params.get("messageId")
	};
}
function initialMessageBody(params) {
	return params.get("event") === "sms-deliver" ? "" : params.get("body") ?? "";
}
function MessagesPageView() {
	const params = useLaunchParams();
	const [address, setAddress] = useState(() => params.get("recipient") ?? params.get("sender") ?? "");
	const [body, setBody] = useState(() => initialMessageBody(params));
	const [incomingSms, setIncomingSms] = useState(() => readIncomingSmsContext(params));
	const [messages, setMessages] = useState([]);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(() => {
		const event = params.get("event");
		if (!event) return null;
		if (params.get("unsupported")) return `${event}: MMS WAP push needs parser support.`;
		return event;
	});
	const [error, setError] = useState(null);
	useEffect(() => {
		setIncomingSms(readIncomingSmsContext(params));
		setAddress(params.get("recipient") ?? params.get("sender") ?? "");
		setBody(initialMessageBody(params));
		const event = params.get("event");
		if (event) setNotice(params.get("unsupported") ? `${event}: MMS WAP push needs parser support.` : event);
	}, [params]);
	const refresh = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const plugins = getPlugins();
			if (typeof plugins.messages.plugin.listMessages !== "function") throw new Error("ElizaMessages plugin is unavailable");
			setMessages((await plugins.messages.plugin.listMessages({ limit: 100 })).messages);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);
	const send = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const trimmedAddress = address.trim();
			const trimmedBody = body.trim();
			if (!trimmedAddress) throw new Error("address is required");
			if (!trimmedBody) throw new Error("body is required");
			const plugins = getPlugins();
			if (typeof plugins.messages.plugin.sendSms !== "function") throw new Error("ElizaMessages plugin is unavailable");
			setNotice(`SMS sent and saved as message ${(await plugins.messages.plugin.sendSms({
				address: trimmedAddress,
				body: trimmedBody
			})).messageId}.`);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto grid w-full max-w-5xl gap-4 p-4 lg:grid-cols-[minmax(280px,360px)_1fr]",
		children: [(0, import_jsx_runtime.jsx)(Panel, {
			title: "Compose",
			description: "Send through Android SMS Manager.",
			children: (0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-3",
				children: [
					incomingSms ? (0, import_jsx_runtime.jsxs)("div", {
						className: "rounded border border-border bg-bg p-3 text-sm",
						children: [
							(0, import_jsx_runtime.jsxs)("div", {
								className: "flex flex-wrap items-center justify-between gap-2 text-xs text-muted",
								children: [(0, import_jsx_runtime.jsx)("span", { children: incomingSms.sender || "unknown sender" }), (0, import_jsx_runtime.jsx)("span", { children: incomingSms.timestamp ? formatTimestamp(incomingSms.timestamp) : "Unknown time" })]
							}),
							(0, import_jsx_runtime.jsx)("p", {
								className: "mt-2 whitespace-pre-wrap text-txt",
								children: incomingSms.body || "Empty SMS body"
							}),
							incomingSms.messageId ? (0, import_jsx_runtime.jsxs)("div", {
								className: "mt-2 text-xs text-muted",
								children: ["message ", incomingSms.messageId]
							}) : null
						]
					}) : null,
					(0, import_jsx_runtime.jsx)(TextInput, {
						label: "Address",
						placeholder: "+15551234567",
						value: address,
						onChange: setAddress
					}),
					(0, import_jsx_runtime.jsx)(TextArea, {
						label: "Body",
						placeholder: "Message",
						value: body,
						onChange: setBody
					}),
					(0, import_jsx_runtime.jsx)(PrimaryButton, {
						disabled: busy,
						icon: (0, import_jsx_runtime.jsx)(Send, { className: "h-4 w-4" }),
						onClick: send,
						children: "Send SMS"
					}),
					(0, import_jsx_runtime.jsx)(StatusNotice, {
						error,
						notice
					})
				]
			})
		}), (0, import_jsx_runtime.jsxs)(Panel, {
			title: "Messages",
			description: "Recent rows from Android's SMS provider.",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "mb-3",
				children: (0, import_jsx_runtime.jsx)(SecondaryButton, {
					disabled: busy,
					icon: (0, import_jsx_runtime.jsx)(RefreshCw, { className: "h-4 w-4" }),
					onClick: refresh,
					children: "Refresh"
				})
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "grid max-h-[60vh] gap-2 overflow-y-auto",
				children: messages.length > 0 ? messages.map((message) => (0, import_jsx_runtime.jsxs)("div", {
					className: "rounded border border-border bg-bg p-3 text-sm",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-wrap items-center justify-between gap-2 text-xs text-muted",
						children: [(0, import_jsx_runtime.jsx)("span", { children: message.address || "unknown address" }), (0, import_jsx_runtime.jsxs)("span", { children: [
							messageTypeLabel(message.type),
							" ·",
							" ",
							new Date(message.date).toLocaleString()
						] })]
					}), (0, import_jsx_runtime.jsx)("p", {
						className: "mt-2 whitespace-pre-wrap text-txt",
						children: message.body
					})]
				}, message.id)) : (0, import_jsx_runtime.jsx)(EmptyState, { children: "No messages returned by Android." })
			})]
		})]
	});
}
function ContactsPageView() {
	const [query, setQuery] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [phoneNumber, setPhoneNumber] = useState("");
	const [emailAddress, setEmailAddress] = useState("");
	const [contacts, setContacts] = useState([]);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(null);
	const [error, setError] = useState(null);
	const listOptions = useMemo(() => ({
		limit: 100,
		query: query.trim() || void 0
	}), [query]);
	const refresh = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const plugins = getPlugins();
			if (typeof plugins.contacts.plugin.listContacts !== "function") throw new Error("ElizaContacts plugin is unavailable");
			setContacts((await plugins.contacts.plugin.listContacts(listOptions)).contacts);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [listOptions]);
	useEffect(() => {
		refresh();
	}, [refresh]);
	const create = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const name = displayName.trim();
			const number = phoneNumber.trim();
			const email = emailAddress.trim();
			if (!name) throw new Error("displayName is required");
			const plugins = getPlugins();
			if (typeof plugins.contacts.plugin.createContact !== "function") throw new Error("ElizaContacts plugin is unavailable");
			setNotice(`Created contact ${(await plugins.contacts.plugin.createContact({
				displayName: name,
				phoneNumber: number || void 0,
				emailAddress: email || void 0
			})).id}.`);
			setDisplayName("");
			setPhoneNumber("");
			setEmailAddress("");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto grid w-full max-w-5xl gap-4 p-4 lg:grid-cols-[minmax(280px,360px)_1fr]",
		children: [(0, import_jsx_runtime.jsx)(Panel, {
			title: "Create Contact",
			description: "Write into Android Contacts Provider.",
			children: (0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-3",
				children: [
					(0, import_jsx_runtime.jsx)(TextInput, {
						label: "Display Name",
						value: displayName,
						onChange: setDisplayName
					}),
					(0, import_jsx_runtime.jsx)(TextInput, {
						label: "Phone Number",
						value: phoneNumber,
						onChange: setPhoneNumber
					}),
					(0, import_jsx_runtime.jsx)(TextInput, {
						label: "Email",
						value: emailAddress,
						onChange: setEmailAddress
					}),
					(0, import_jsx_runtime.jsx)(PrimaryButton, {
						disabled: busy,
						icon: (0, import_jsx_runtime.jsx)(UserPlus, { className: "h-4 w-4" }),
						onClick: create,
						children: "Create"
					}),
					(0, import_jsx_runtime.jsx)(StatusNotice, {
						error,
						notice
					})
				]
			})
		}), (0, import_jsx_runtime.jsxs)(Panel, {
			title: "Contacts",
			description: "Read from Android Contacts Provider.",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "mb-3 flex flex-col gap-2 sm:flex-row",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "min-w-0 flex-1",
					children: (0, import_jsx_runtime.jsx)(TextInput, {
						label: "Search",
						placeholder: "Name, number, or email",
						value: query,
						onChange: setQuery
					})
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "flex items-end",
					children: (0, import_jsx_runtime.jsx)(SecondaryButton, {
						disabled: busy,
						icon: (0, import_jsx_runtime.jsx)(RefreshCw, { className: "h-4 w-4" }),
						onClick: refresh,
						children: "Refresh"
					})
				})]
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "grid max-h-[60vh] gap-2 overflow-y-auto",
				children: contacts.length > 0 ? contacts.map((contact) => (0, import_jsx_runtime.jsxs)("div", {
					className: "rounded border border-border bg-bg p-3 text-sm",
					children: [
						(0, import_jsx_runtime.jsx)("div", {
							className: "font-medium text-txt",
							children: contact.displayName
						}),
						(0, import_jsx_runtime.jsx)("div", {
							className: "mt-1 text-muted",
							children: contact.phoneNumbers.length > 0 ? contact.phoneNumbers.join(", ") : "No phone numbers"
						}),
						contact.emailAddresses.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
							className: "mt-1 text-xs text-muted",
							children: contact.emailAddresses.join(", ")
						}) : null
					]
				}, contact.id)) : (0, import_jsx_runtime.jsx)(EmptyState, { children: "No contacts returned by Android." })
			})]
		})]
	});
}

//#endregion
export { ContactsPageView, MessagesPageView, PhonePageView };