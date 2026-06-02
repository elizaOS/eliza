// odysseus Email client (static/js/emailLibrary.js + emailInbox.js + signature.js
// + the `email-*` rules in style.css). The full mail surface: an accounts strip
// ("All (default)" + per-account chips), a folder + filter toolbar, a search
// row with undone / reminder / attachment quick-toggles, a message list whose
// rows carry a per-sender pastel avatar, sender/date, urgency dot (red ≥3 /
// orange =2), attachment + tag pills, a reading split-pane (From/To/Cc chips +
// Reply / Reply-all / Forward / AI-reply / Summary actions + body), a compose
// draft surface, and a saved-signatures picker (signature.js `pick`).
//
// elizaMapping: odysseus's email is IMAP/SMTP-backed via its own Python routes
// (/api/email/list, /read, /accounts, /folders, …). eliza has NO email backend
// — none of the @elizaos/ui `client` methods map to a mail store. The
// cross-channel `client.getInbox*` methods are connector chats (imessage /
// telegram / discord), a different surface, NOT email. So this is the faithful
// no-eliza-equivalent path: every component is built pixel-exact so it lights
// up the moment a mail client method exists, but the default is odysseus's own
// honest empty state ("No account connected" / "No emails") — never seeded with
// fabricated/representative messages presented as if the agent fetched them.

import {
  Bell,
  Check,
  Forward,
  MoreVertical,
  Paperclip,
  PenLine,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { readPref } from "./util/storage";

// Local-prefs key for the saved-signature list (signature.js persists these
// server-side via /api/signatures; with no eliza backend they live locally).
// Not in the shared PREF_KEYS table — this view owns its own non-shared pref.
const SIGNATURES_PREF_KEY = "email-signatures";

// ── Folder + filter model (emailLibrary.js folder select + filter select) ──
type FilterValue =
  | "all"
  | "unread"
  | "favorites"
  | "undone"
  | "reminders"
  | "unanswered";

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "favorites", label: "Favorites" },
  { value: "undone", label: "Undone" },
  { value: "reminders", label: "Reminders" },
  { value: "unanswered", label: "Unanswered" },
];

// odysseus emailInbox.js folderDisplayName ordering — the canonical role list
// the folder dropdown surfaces (sortedFolders roleOrder). Rendered as the
// available folders before any real IMAP folder list arrives.
const DEFAULT_FOLDERS = [
  "INBOX",
  "Sent",
  "Drafts",
  "Archive",
  "Spam",
  "Trash",
] as const;

// ── Domain shapes, mirroring the /api/email/list + /read response fields the
// odysseus renderers read (from_name, from_address, subject, date, is_read,
// is_answered, is_flagged, has_attachments, tags, urgency score). Typed up
// front so the list + reader light up unchanged once a mail client exists. ──
interface EmailAccount {
  id: string;
  name: string;
  address: string;
  isDefault: boolean;
}

interface EmailTag {
  label: string;
}

interface EmailMessage {
  uid: string;
  fromName: string;
  fromAddress: string;
  to: string;
  cc: string;
  subject: string;
  date: number;
  isRead: boolean;
  isAnswered: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  tags: EmailTag[];
  // Urgency-scanner tier: 3 = urgent now (red), 2 = reply soon (orange), else 0.
  urgency: number;
  body: string;
}

interface SavedSignature {
  id: string;
  name: string;
  dataUrl: string;
}

// odysseus emailInbox.js _senderColor — deterministic per-sender pastel hue so
// the same correspondent always gets the same avatar/dot colour. 1:1 hash.
function senderColor(name: string): string {
  if (!name) return "hsl(220, 55%, 65%)";
  const key = name.toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 65%)`;
}

// emailInbox.js _urgencyColor — turns the scanner score into a dot tint.
function urgencyColor(score: number): string {
  if (score >= 3) return "var(--red)";
  if (score === 2) return "#f0ad4e";
  return "";
}

// Narrow a raw <select> value back to FilterValue without an `as` cast — look
// it up against the known FILTERS set, falling back to "all" if unrecognized.
function toFilterValue(raw: string): FilterValue {
  const match = FILTERS.find((f) => f.value === raw);
  return match ? match.value : "all";
}

function initial(name: string): string {
  const n = name.trim();
  return (n.length > 0 ? n[0] : "?").toUpperCase();
}

// emailInbox.js _createEmailItem date formatting — time if today, else MMM D.
function formatListDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function EmailView({
  open,
  onClose,
  accounts = [],
  messages = [],
}: {
  open: boolean;
  onClose: () => void;
  accounts?: EmailAccount[];
  messages?: EmailMessage[];
}): ReactNode {
  useEscapeClose(open, onClose);

  const [accountId, setAccountId] = useState<string | null>(null);
  const [folder, setFolder] = useState<string>("INBOX");
  const [filter, setFilter] = useState<FilterValue>("all");
  const [search, setSearch] = useState("");
  const [undoneOnly, setUndoneOnly] = useState(false);
  const [reminderOnly, setReminderOnly] = useState(false);
  const [attachmentsOnly, setAttachmentsOnly] = useState(false);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [draftTo, setDraftTo] = useState("");
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [sigPickerOpen, setSigPickerOpen] = useState(false);
  const [signatures, setSignatures] = useState<SavedSignature[]>([]);

  useEffect(() => {
    if (!open) return;
    setSignatures(readPref<SavedSignature[]>(SIGNATURES_PREF_KEY, []));
  }, [open]);

  // Folder list: real IMAP folders would replace this; the role-ordered default
  // set is what odysseus shows before a folder fetch lands.
  const folders = useMemo<string[]>(() => [...DEFAULT_FOLDERS], []);

  // No eliza client method backs a mail store (see file header) — the message
  // set is intentionally empty unless data is passed in, so the honest empty
  // state is the default. The filter pipeline below is wired against the typed
  // set so the list lights up unchanged once a backend exists.
  const visibleMessages = useMemo<EmailMessage[]>(() => {
    const q = search.trim().toLowerCase();
    return messages.filter((m) => {
      if (filter === "unread" && m.isRead) return false;
      if (filter === "favorites" && !m.isFlagged) return false;
      if (filter === "undone" && m.isAnswered) return false;
      if (filter === "unanswered" && m.isAnswered) return false;
      if (undoneOnly && m.isAnswered) return false;
      if (attachmentsOnly && !m.hasAttachments) return false;
      if (q.length > 0) {
        const hay =
          `${m.subject} ${m.fromName} ${m.fromAddress} ${m.body}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [messages, filter, search, undoneOnly, attachmentsOnly]);

  if (!open) return null;

  const isSentFolder = /sent/i.test(folder);
  const selected =
    selectedUid !== null
      ? (visibleMessages.find((m) => m.uid === selectedUid) ?? null)
      : null;
  const unreadCount = messages.filter((m) => !m.isRead).length;

  const startCompose = () => {
    setComposing(true);
    setSelectedUid(null);
    setDraftTo("");
    setDraftSubject("");
    setDraftBody("");
  };

  const closeCompose = () => {
    setComposing(false);
    setDraftTo("");
    setDraftSubject("");
    setDraftBody("");
  };

  const startReply = (
    m: EmailMessage,
    mode: "reply" | "reply-all" | "forward",
  ) => {
    setSelectedUid(null);
    setComposing(true);
    if (mode === "forward") {
      setDraftTo("");
      setDraftSubject(
        /^fwd?\s*:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
      );
    } else {
      setDraftTo(m.fromAddress);
      setDraftSubject(
        /^re\s*:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      );
    }
    setDraftBody("");
  };

  const insertSignature = (sig: SavedSignature) => {
    setDraftBody((b) => `${b}\n\n— ${sig.name}`);
    setSigPickerOpen(false);
  };

  // No real search backend — short queries collapse back to the list like
  // emailLibrary.js _doSearch (q.length < 2 → render the regular list).
  const statsLabel =
    visibleMessages.length === 1
      ? "1 email"
      : `${visibleMessages.length} emails`;

  return (
    <div
      className="od-search-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Email"
    >
      <button
        type="button"
        aria-label="Close email"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-email-panel">
        {/* ── Header (emailLibrary.js modal-header) ── */}
        <div className="od-email-head">
          <span className="od-email-head-title">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
              aria-label="Email"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
            Email
            {unreadCount > 0 ? (
              <span className="od-email-unread-badge">
                {unreadCount > 999 ? "999+ unread" : `${unreadCount} unread`}
              </span>
            ) : null}
            <span className="od-email-stats">{statsLabel}</span>
          </span>
          <button
            type="button"
            className="od-email-close"
            onClick={onClose}
            aria-label="Close email"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <p className="od-email-desc">
          All emails. Click to open in the reading pane.
        </p>

        {/* ── Accounts strip (emailLibrary.js _renderAccountsStrip) ── */}
        <div className="od-email-accounts-row">
          <div className="od-email-accounts">
            <button
              type="button"
              className={`od-email-chip${accountId === null ? " active" : ""}`}
              onClick={() => setAccountId(null)}
            >
              All (default)
            </button>
            {accounts.map((a) => (
              <button
                type="button"
                key={a.id}
                className={`od-email-chip${accountId === a.id ? " active" : ""}`}
                title={`${a.address}${a.isDefault ? " (default)" : ""}`}
                onClick={() => setAccountId(a.id)}
              >
                {a.name || a.address}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="od-email-compose-btn"
            onClick={startCompose}
            title="New email"
          >
            <PenLine size={11} />
            <span>New</span>
          </button>
        </div>

        {/* ── Toolbar: folder + filter selects, search row, quick toggles ── */}
        <div className="od-email-toolbar">
          <div className="od-email-toolbar-row">
            <select
              className="od-email-select"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              aria-label="Folder"
            >
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f === "INBOX" ? "INBOX" : f}
                </option>
              ))}
            </select>
            <select
              className="od-email-select"
              value={filter}
              onChange={(e) => setFilter(toFilterValue(e.target.value))}
              aria-label="Filter"
            >
              {FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="od-email-tbtn"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="od-email-search-row">
            <span className="od-email-search-wrap">
              <Search size={12} className="od-email-search-icon" />
              <input
                type="text"
                className="od-email-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onClose();
                }}
                placeholder="Search emails…"
                aria-label="Search emails"
              />
            </span>
            <button
              type="button"
              className={`od-email-tbtn${undoneOnly ? " active" : ""}`}
              title="Show only emails not marked as done"
              aria-pressed={undoneOnly}
              onClick={() => setUndoneOnly((v) => !v)}
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              className={`od-email-tbtn${reminderOnly ? " active" : ""}`}
              title="Show reminder emails"
              aria-pressed={reminderOnly}
              onClick={() => setReminderOnly((v) => !v)}
            >
              <Bell size={12} />
            </button>
            <button
              type="button"
              className={`od-email-tbtn${attachmentsOnly ? " active" : ""}`}
              title="Show only emails with attachments"
              aria-pressed={attachmentsOnly}
              onClick={() => setAttachmentsOnly((v) => !v)}
            >
              <Paperclip size={12} />
            </button>
          </div>
        </div>

        {/* ── Split body: message list + reading/compose pane ── */}
        <div className="od-email-body">
          <div className="od-email-list">
            {accounts.length === 0 && messages.length === 0 ? (
              <div className="od-email-empty">
                <span className="od-email-empty-title">
                  No account connected
                </span>
                <span className="od-email-empty-sub">
                  Set up at: Settings › Integrations
                </span>
              </div>
            ) : visibleMessages.length === 0 ? (
              <div className="od-email-empty">
                <span className="od-email-empty-title">No emails</span>
              </div>
            ) : (
              visibleMessages.map((m) => {
                const senderName = isSentFolder
                  ? m.to || "(no recipient)"
                  : m.fromName || m.fromAddress;
                const color = senderColor(senderName);
                const dotColor = urgencyColor(m.urgency) || color;
                const cls = [
                  "od-email-item",
                  m.isAnswered ? "od-email-answered" : "",
                  !m.isRead ? "od-email-unread" : "",
                  m.uid === selectedUid ? "od-email-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <button
                    type="button"
                    key={m.uid}
                    className={cls}
                    onClick={() => {
                      setComposing(false);
                      setSelectedUid(m.uid);
                    }}
                  >
                    <span
                      className="od-email-avatar"
                      style={{ background: color }}
                    >
                      {initial(senderName)}
                    </span>
                    <span className="od-email-item-content">
                      <span className="od-email-item-top">
                        <span className="od-email-sender" style={{ color }}>
                          {isSentFolder ? `to ${senderName}` : senderName}
                        </span>
                        <span className="od-email-date">
                          {formatListDate(m.date)}
                        </span>
                      </span>
                      <span className="od-email-subject">
                        {m.subject || "(no subject)"}
                        {!m.isRead && !m.isAnswered ? (
                          <span
                            className="od-email-unread-dot"
                            style={{ color: dotColor }}
                            title={
                              m.urgency >= 3
                                ? "Urgent — needs reply now"
                                : m.urgency === 2
                                  ? "Reply soon"
                                  : "Unread"
                            }
                          >
                            <svg
                              width="8"
                              height="8"
                              viewBox="0 0 24 24"
                              fill="currentColor"
                              role="img"
                              aria-label="Unread"
                            >
                              <circle cx="12" cy="12" r="6" />
                            </svg>
                          </span>
                        ) : null}
                        {m.hasAttachments ? (
                          <span
                            className="od-email-attach-ico"
                            title="Has attachments"
                          >
                            <Paperclip size={10} />
                          </span>
                        ) : null}
                        {m.tags.length > 0 ? (
                          <span className="od-email-tags">
                            {m.tags.map((t) => (
                              <span
                                key={t.label}
                                className={`od-email-tag od-email-tag-${t.label}`}
                              >
                                {t.label}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="od-email-item-menu" aria-hidden="true">
                      <MoreVertical size={14} />
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* ── Reading / compose pane (emailLibrary.js reader split-pane) ── */}
          <div className="od-email-pane">
            {composing ? (
              <div className="od-email-compose">
                <div className="od-email-compose-head">
                  <span className="od-email-compose-title">New message</span>
                  <button
                    type="button"
                    className="od-email-tbtn"
                    onClick={closeCompose}
                    aria-label="Discard draft"
                    title="Discard"
                  >
                    <X size={13} />
                  </button>
                </div>
                <label className="od-email-field">
                  <span className="od-email-field-label">To</span>
                  <input
                    type="text"
                    className="od-email-field-input"
                    value={draftTo}
                    onChange={(e) => setDraftTo(e.target.value)}
                    placeholder="recipient@example.com"
                  />
                </label>
                <label className="od-email-field">
                  <span className="od-email-field-label">Subject</span>
                  <input
                    type="text"
                    className="od-email-field-input"
                    value={draftSubject}
                    onChange={(e) => setDraftSubject(e.target.value)}
                    placeholder="Subject"
                  />
                </label>
                <textarea
                  className="od-email-compose-body"
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  placeholder="Write your message…"
                  aria-label="Message body"
                />
                <div className="od-email-compose-footer">
                  <button
                    type="button"
                    className="od-email-sig-btn"
                    onClick={() => setSigPickerOpen(true)}
                  >
                    <PenLine size={12} />
                    Signature
                  </button>
                  <span className="od-email-compose-spacer" />
                  <button
                    type="button"
                    className="od-email-send-btn"
                    disabled={!draftTo.trim()}
                    title="Email send has no eliza backend yet"
                  >
                    Send
                  </button>
                </div>
              </div>
            ) : selected ? (
              <div className="od-email-reader">
                <div className="od-email-reader-header">
                  <div className="od-email-reader-meta">
                    <div className="od-email-reader-meta-row">
                      <strong>From:</strong>
                      <span className="od-email-recipient-chips">
                        <span
                          className="od-email-recipient-chip"
                          title={`${selected.fromName} <${selected.fromAddress}>`}
                        >
                          {selected.fromName || selected.fromAddress}
                        </span>
                      </span>
                    </div>
                    {selected.to ? (
                      <div className="od-email-reader-meta-row">
                        <strong>To:</strong>
                        <span className="od-email-recipient-chips">
                          {selected.to
                            .split(",")
                            .map((a) => a.trim())
                            .filter(Boolean)
                            .map((a) => (
                              <span
                                key={a}
                                className="od-email-recipient-chip"
                                title={a}
                              >
                                {a}
                              </span>
                            ))}
                        </span>
                      </div>
                    ) : null}
                    {selected.cc ? (
                      <div className="od-email-reader-meta-row">
                        <strong>Cc:</strong>
                        <span className="od-email-recipient-chips">
                          {selected.cc
                            .split(",")
                            .map((a) => a.trim())
                            .filter(Boolean)
                            .map((a) => (
                              <span
                                key={a}
                                className="od-email-recipient-chip"
                                title={a}
                              >
                                {a}
                              </span>
                            ))}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="od-email-reader-actions">
                    <button
                      type="button"
                      className="od-email-reader-btn"
                      title="Reply"
                      onClick={() => startReply(selected, "reply")}
                    >
                      <Reply size={14} />
                      <span className="od-email-reader-btn-label">Reply</span>
                    </button>
                    <button
                      type="button"
                      className="od-email-reader-btn"
                      title="Reply all"
                      onClick={() => startReply(selected, "reply-all")}
                    >
                      <ReplyAll size={14} />
                      <span className="od-email-reader-btn-label">
                        Reply all
                      </span>
                    </button>
                    <button
                      type="button"
                      className="od-email-reader-btn"
                      title="Forward"
                      onClick={() => startReply(selected, "forward")}
                    >
                      <Forward size={14} />
                      <span className="od-email-reader-btn-label">Forward</span>
                    </button>
                    <button
                      type="button"
                      className="od-email-reader-btn"
                      title="AI reply"
                    >
                      <Sparkles size={14} />
                      <span className="od-email-reader-btn-label">
                        AI reply
                      </span>
                    </button>
                    <button
                      type="button"
                      className="od-email-reader-btn"
                      title="Summarize"
                    >
                      <Search size={14} />
                      <span className="od-email-reader-btn-label">Summary</span>
                    </button>
                  </div>
                </div>
                <div className="od-email-reader-subject">
                  {selected.subject || "(no subject)"}
                  {selected.isFlagged ? (
                    <Star size={13} className="od-email-reader-star" />
                  ) : null}
                </div>
                <div className="od-email-reader-body">{selected.body}</div>
              </div>
            ) : (
              <div className="od-email-pane-placeholder">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  role="img"
                  aria-label="No message selected"
                >
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                </svg>
                <span>Select a message to read it here.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Signature picker (signature.js pick) ── */}
      {sigPickerOpen ? (
        <div
          className="od-email-sig-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a signature"
        >
          <button
            type="button"
            className="od-search-backdrop"
            aria-label="Close signature picker"
            onClick={() => setSigPickerOpen(false)}
          />
          <div className="od-email-sig-panel">
            <div className="od-mem-head">
              <span className="od-mem-title">Choose a signature</span>
              <button
                type="button"
                className="od-email-tbtn"
                onClick={() => setSigPickerOpen(false)}
                aria-label="Close"
                title="Close"
              >
                <X size={14} />
              </button>
            </div>
            {signatures.length === 0 ? (
              <div className="od-email-sig-empty">No saved signatures yet.</div>
            ) : (
              <div className="od-email-sig-grid">
                {signatures.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    className="od-email-sig-tile"
                    onClick={() => insertSignature(s)}
                  >
                    <img src={s.dataUrl} alt={s.name} />
                    <span className="od-email-sig-name">{s.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
