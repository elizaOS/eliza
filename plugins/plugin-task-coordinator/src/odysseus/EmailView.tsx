// odysseus Email client (static/js/emailLibrary.js + emailInbox.js + signature.js
// + the `email-*` rules in style.css). The full mail surface: an accounts strip
// ("All (default)" + per-account chips), a folder + filter toolbar (with the
// Pending/Stale buckets + a Tags optgroup), a search row with undone / attachment
// quick-toggles, a multi-select bulk bar, a message list whose rows carry a
// per-sender pastel avatar, sender/date, urgency dot (red ≥3 / orange =2),
// attachment + tag pills, a per-row done check + a ⋮ actions menu, a reading
// split-pane (From/To/Cc chips + Reply / Reply-all / Forward actions + collapsible
// attachments + body), a compose draft surface, and a saved-signatures picker with
// a draw-new capture pad (signature.js `pick`/`capture`).
//
// elizaMapping: odysseus's email is IMAP/SMTP-backed via its own Python routes
// (/api/email/list, /read, /accounts, /folders, mark-answered, archive, delete…).
// eliza has NO email backend — none of the @elizaos/ui `client` methods map to a
// mail store (the cross-channel `client.getInbox*` methods are connector chats:
// imessage / telegram / discord, a different surface, NOT email). So this is the
// faithful no-eliza-equivalent path: every surface is built pixel-exact so it
// lights up the moment a mail backend exists. Controls that only mutate local view
// state (done check, read/unread, select, compose) work today; controls that need
// a server round-trip (Archive, Delete, Remind, Clear reminders, AI reply, Summary,
// Send, attachment download) are wired to optional callback props and only render
// when the host supplies a handler — never as dead buttons that route nowhere. The
// default is odysseus's own honest empty state ("No account connected" / "No
// emails"), never seeded with fabricated messages presented as agent-fetched.

import {
  Archive,
  Bell,
  Check,
  Copy,
  Eraser,
  Forward,
  Menu,
  Minus,
  MoreVertical,
  Paperclip,
  PenLine,
  RefreshCw,
  Reply,
  ReplyAll,
  RotateCcw,
  Search,
  Smile,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { Spinner } from "./Spinner";
import { readPref, writePref } from "./util/storage";

// Local-prefs key for the saved-signature list (signature.js persists these
// server-side via /api/signatures; with no eliza backend they live locally).
// Not in the shared PREF_KEYS table — this view owns its own non-shared pref.
const SIGNATURES_PREF_KEY = "email-signatures";
// signature.js _loadSmoothness/_saveSmoothness — the draw-pad smoothing level.
const SIGNATURE_SMOOTH_PREF_KEY = "email-signature-smoothness";

// ── Folder + filter model (emailLibrary.js folder select + filter select) ──
// `tag:*` values mirror the Tags optgroup in emailLibrary.js (lines 631-639).
type FilterValue =
  | "all"
  | "unread"
  | "favorites"
  | "undone"
  | "reminders"
  | "unanswered"
  | "pending_30d"
  | "stale_30d"
  | "tag:urgent"
  | "tag:reply-soon"
  | "tag:spam"
  | "tag:newsletter"
  | "tag:marketing";

// Flat filters (emailLibrary.js email-lib-filter options, lines 623-630).
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "favorites", label: "Favorites" },
  { value: "undone", label: "Undone" },
  { value: "reminders", label: "Reminders" },
  { value: "unanswered", label: "Unanswered" },
  { value: "pending_30d", label: "Pending · 30d" },
  { value: "stale_30d", label: "Stale · >30d" },
];

// Tags optgroup (emailLibrary.js lines 631-639). `tag` is the bare label the
// urgency-scanner / sorter stamps on a message; the option value is `tag:<tag>`.
const TAG_FILTERS: { value: FilterValue; tag: string; label: string }[] = [
  { value: "tag:urgent", tag: "urgent", label: "Urgent" },
  { value: "tag:reply-soon", tag: "reply-soon", label: "Reply soon" },
  { value: "tag:spam", tag: "spam", label: "Spam" },
  { value: "tag:newsletter", tag: "newsletter", label: "Newsletter" },
  { value: "tag:marketing", tag: "marketing", label: "Marketing" },
];

const ALL_FILTERS: { value: FilterValue; label: string }[] = [
  ...FILTERS,
  ...TAG_FILTERS.map((t) => ({ value: t.value, label: t.label })),
];

// Window for the Pending · 30d / Stale · >30d buckets (30 days in ms).
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// emailLibrary.js folder select initial markup (lines 622-624): before any IMAP
// folder list arrives, the dropdown carries a single static option —
// `<option value="INBOX">Inbox</option>` (title-case "Inbox"). The full
// role-ordered set (Sent/Drafts/Archive/…) is only surfaced once a real folder
// fetch lands (emailInbox.js sortedFolders), which never happens without a mail
// backend, so we render only the initial Inbox option here. A `folders` prop
// can override this once folder data exists.
const INITIAL_FOLDERS: { value: string; label: string }[] = [
  { value: "INBOX", label: "Inbox" },
];

// ── Domain shapes, mirroring the /api/email/list + /read response fields the
// odysseus renderers read (from_name, from_address, subject, date, is_read,
// is_answered, is_flagged, has_attachments, attachments, tags, urgency score).
// Typed up front so the list + reader light up unchanged once a mail client
// exists. ──
interface EmailAccount {
  id: string;
  name: string;
  address: string;
  isDefault: boolean;
}

interface EmailTag {
  label: string;
}

// emailLibrary.js attachment record (uid + index identify it for download).
interface EmailAttachment {
  index: number;
  filename: string;
  // Byte size — rendered as KB in the chip (emailLibrary.js `att-size`).
  size: number;
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
  attachments: EmailAttachment[];
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

// emailLibrary.js _showLibRemindSubmenu presets (Later today / Tomorrow / Next
// week / custom). Resolved against `now` each time the submenu opens.
interface RemindPreset {
  key: string;
  label: string;
  sub: string;
  date: Date;
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
// it up against the known filter set, falling back to "all" if unrecognized.
function toFilterValue(raw: string): FilterValue {
  const match = ALL_FILTERS.find((f) => f.value === raw);
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

// emailLibrary.js _splitRecipientList — split a comma-separated address list
// while honoring quotes + angle brackets, so '"Doe, John" <j@x>' is one entry
// and not torn apart on its internal comma (1:1 with the JS scanner).
function splitRecipientList(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  let angle = false;
  const s = raw;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") quote = !quote;
    else if (ch === "<" && !quote) angle = true;
    else if (ch === ">" && !quote) angle = false;

    if (ch === "," && !quote && !angle) {
      const part = cur.trim();
      if (part) out.push(part);
      cur = "";
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

// emailLibrary/utils.js _extractName — the display name from a `Name <addr>`
// recipient string, falling back to the local-part of the address.
function extractRecipientName(addr: string): string {
  const m = addr.match(/^"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (m) return m[1].trim();
  const localPart = addr.split("@")[0];
  return localPart || addr;
}

// emailLibrary.js _emailAddressFromRecipientText — pull the bare address out of
// a recipient string (prefer the angle-bracketed form), used by the copy chip.
function extractRecipientAddress(text: string): string {
  const raw = text.trim();
  const angle = raw.match(/<\s*([^<>@\s]+@[^<>\s]+)\s*>/);
  if (angle) return angle[1].trim();
  const any = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return any ? any[0].trim() : raw;
}

// emailLibrary.js _showLibRemindSubmenu — compute the Later today / Tomorrow /
// Next week preset dates relative to now (1:1 with the JS math).
function buildRemindPresets(now: Date): RemindPreset[] {
  const laterToday = new Date(now);
  const sixPm = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    18,
    0,
  );
  if (sixPm.getTime() - now.getTime() < 60 * 60 * 1000) {
    laterToday.setTime(now.getTime() + 3 * 60 * 60 * 1000);
  } else {
    laterToday.setTime(sixPm.getTime());
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  const daysUntilMon = (8 - now.getDay()) % 7 || 7;
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + daysUntilMon);
  nextWeek.setHours(8, 0, 0, 0);
  const timeFmt: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  return [
    {
      key: "later",
      label: "Later today",
      sub: laterToday.toLocaleTimeString([], timeFmt),
      date: laterToday,
    },
    {
      key: "tomorrow",
      label: "Tomorrow",
      sub: tomorrow.toLocaleTimeString([], timeFmt),
      date: tomorrow,
    },
    {
      key: "nextweek",
      label: "Next week",
      sub: `${nextWeek.toLocaleDateString([], { weekday: "short" })} ${nextWeek.toLocaleTimeString([], timeFmt)}`,
      date: nextWeek,
    },
  ];
}

// signature.js _smoothnessToParams / SmoothPad — a minimal moving-average draw
// pad. `smooth` 0..10 maps to how many trailing points get averaged into the
// rendered point, matching the JS pad's perceived smoothing.
class SmoothPad {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly strokes: { x: number; y: number }[][] = [];
  private current: { x: number; y: number }[] | null = null;
  private window: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    smooth: number,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("[EmailView] 2D canvas context unavailable");
    this.ctx = ctx;
    this.window = SmoothPad.windowFor(smooth);
    this.ctx.lineWidth = 2.4;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
  }

  private static windowFor(smooth: number): number {
    return 1 + Math.round(Math.max(0, Math.min(10, smooth)) * 0.6);
  }

  setSmoothness(smooth: number): void {
    this.window = SmoothPad.windowFor(smooth);
  }

  private point(ev: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * this.canvas.width,
      y: ((ev.clientY - rect.top) / rect.height) * this.canvas.height,
    };
  }

  begin(ev: PointerEvent): void {
    this.current = [this.point(ev)];
    this.strokes.push(this.current);
  }

  extend(ev: PointerEvent): void {
    if (!this.current) return;
    this.current.push(this.point(ev));
    this.redraw();
  }

  end(): void {
    this.current = null;
  }

  undo(): void {
    this.strokes.pop();
    this.redraw();
  }

  clear(): void {
    this.strokes.length = 0;
    this.current = null;
    this.redraw();
  }

  isEmpty(): boolean {
    return this.strokes.every((s) => s.length < 2);
  }

  private smoothed(stroke: { x: number; y: number }[]): {
    x: number;
    y: number;
  }[] {
    if (this.window <= 1) return stroke;
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < stroke.length; i++) {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let j = Math.max(0, i - this.window + 1); j <= i; j++) {
        sx += stroke[j].x;
        sy += stroke[j].y;
        n++;
      }
      out.push({ x: sx / n, y: sy / n });
    }
    return out;
  }

  private redraw(): void {
    const styles = getComputedStyle(this.canvas);
    this.ctx.strokeStyle = styles.color || "#000";
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const stroke of this.strokes) {
      const pts = this.smoothed(stroke);
      if (pts.length < 2) continue;
      this.ctx.beginPath();
      this.ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        this.ctx.lineTo(pts[i].x, pts[i].y);
      }
      this.ctx.stroke();
    }
  }

  toDataUrl(): string {
    return this.canvas.toDataURL("image/png");
  }
}

// emailLibrary.js _recipientChipHtml + _wireRecipientChips — a From/To/Cc chip
// that toggles between its display name and the full "Name <addr>" form on
// click; expanded it reveals a small copy button that writes the bare address
// to the clipboard, flashes a copied state, and surfaces the "Email copied"
// toast (here via the parent's onCopied callback). 1:1 with the JS behavior.
function RecipientChip({
  full,
  label,
  className,
  onCopied,
}: {
  full: string;
  label: string;
  className?: string;
  onCopied: () => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const revertRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (revertRef.current !== null) clearTimeout(revertRef.current);
    },
    [],
  );

  const fullText = full.trim();
  const address = extractRecipientAddress(fullText);
  const labelText = (label || address || fullText).trim();
  const display = expanded ? fullText || labelText : labelText;

  const onCopy = useCallback(() => {
    // Guard for non-secure-context / older webviews where clipboard is absent
    // (mirrors the ChatMessages copy affordance).
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
      return;
    if (!address) return;
    navigator.clipboard.writeText(address).then(
      () => {
        setCopied(true);
        onCopied();
        if (revertRef.current !== null) clearTimeout(revertRef.current);
        revertRef.current = setTimeout(() => setCopied(false), 900);
      },
      () => undefined,
    );
  }, [address, onCopied]);

  return (
    <span
      className={`od-email-recipient-chip${expanded ? " expanded" : ""}${className ? ` ${className}` : ""}`}
    >
      <button
        type="button"
        className="od-email-recipient-chip-label"
        title={fullText || labelText}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {display}
      </button>
      {expanded ? (
        <button
          type="button"
          className={`od-email-recipient-chip-copy${copied ? " copied" : ""}`}
          title={copied ? "Copied" : "Copy email"}
          aria-label={copied ? "Copied" : "Copy email"}
          onClick={onCopy}
        >
          {copied ? (
            <Check size={11} aria-hidden="true" />
          ) : (
            <Copy size={11} aria-hidden="true" />
          )}
        </button>
      ) : null}
    </span>
  );
}

export function EmailView({
  open,
  onClose,
  loading = false,
  remindersEnabled = false,
  accounts = [],
  messages = [],
  onRefresh,
  onArchive,
  onDelete,
  onRemind,
  onClearReminders,
  onAiReply,
  onSummarize,
  onSend,
  onDownloadAttachment,
}: {
  open: boolean;
  onClose: () => void;
  // While a mail fetch is in flight the grid shows odysseus's whirlpool +
  // "Loading emails" affordance (emailLibrary.js _renderEmailLoading). With no
  // eliza mail backend this stays false, so the honest empty state is default.
  loading?: boolean;
  // emailLibrary.js gates the bell/reminder quick-toggle behind whether the
  // reminder feature is enabled (#email-reminder-btn starts `hidden`). Defaults
  // off so the toggle stays hidden until a backend turns reminders on.
  remindersEnabled?: boolean;
  accounts?: EmailAccount[];
  messages?: EmailMessage[];
  // Server-backed actions — each renders only when its handler is supplied, so
  // the surface is faithful when a mail backend wires it and honest (no dead
  // control) when none exists. eliza has none today, so all default undefined.
  onRefresh?: () => void;
  onArchive?: (uids: string[]) => void;
  onDelete?: (uids: string[]) => void;
  onRemind?: (uid: string, at: Date) => void;
  onClearReminders?: () => void;
  onAiReply?: (uid: string) => void;
  onSummarize?: (uid: string) => void;
  onSend?: (draft: { to: string; subject: string; body: string }) => void;
  onDownloadAttachment?: (uid: string, index: number, filename: string) => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls(
    "win-email",
    { w: 720, h: 800 },
    { label: "Email", icon: "Mail", onClose },
  );

  const [accountId, setAccountId] = useState<string | null>(null);
  const [folder, setFolder] = useState<string>("INBOX");
  const [filter, setFilter] = useState<FilterValue>("all");
  const [search, setSearch] = useState("");
  const [undoneOnly, setUndoneOnly] = useState(false);
  const [attachmentsOnly, setAttachmentsOnly] = useState(false);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [draftTo, setDraftTo] = useState("");
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [sigPickerOpen, setSigPickerOpen] = useState(false);
  const [sigCaptureOpen, setSigCaptureOpen] = useState(false);
  const [signatures, setSignatures] = useState<SavedSignature[]>([]);

  // Per-row ⋮ menu: the uid whose dropdown is open (emailLibrary.js
  // _showCardMenu — one open at a time), plus its remind submenu flag.
  const [menuUid, setMenuUid] = useState<string | null>(null);
  const [remindSubmenuOpen, setRemindSubmenuOpen] = useState(false);

  // Multi-select / bulk bar (emailLibrary.js state._selectMode/_selectedUids).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);

  // Local optimistic overrides for done/read so the per-row check + bulk
  // read/unread give real feedback even before a backend round-trips (matching
  // emailLibrary.js, which flips the visible class as the source of truth). A
  // real onArchive/onSetAnswered backend can layer on top later.
  const [answeredOverride, setAnsweredOverride] = useState<
    Map<string, boolean>
  >(new Map());
  const [readOverride, setReadOverride] = useState<Map<string, boolean>>(
    new Map(),
  );

  // Reader attachments fold state (emailLibrary.js .email-reader-atts-wrap
  // starts `collapsed`).
  const [attsExpanded, setAttsExpanded] = useState(false);

  // Transient "Email copied" status surfaced by the recipient-chip copy button
  // (emailLibrary.js showToast('Email copied')). Mirrors ModelsView's inline
  // feedback pattern since this view has no separate toast surface.
  const [feedback, setFeedback] = useState("");
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
    },
    [],
  );
  const showCopied = useCallback(() => {
    setFeedback("Email copied");
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback((cur) => (cur === "Email copied" ? "" : cur));
    }, 1400);
  }, []);

  // emailLibrary.js _emailReaderForSelectAllTarget — Ctrl/Cmd+A while the open
  // reader is focused selects ONLY the reader body, not the whole document.
  const readerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setSignatures(readPref<SavedSignature[]>(SIGNATURES_PREF_KEY, []));
  }, [open]);

  // Close any open per-row / bulk menu on outside click (emailLibrary.js
  // document-level `close` handler).
  useEffect(() => {
    if (menuUid === null && !bulkMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest(".od-email-menu-anchor")) return;
      setMenuUid(null);
      setRemindSubmenuOpen(false);
      setBulkMenuOpen(false);
    };
    document.addEventListener("click", onDoc, true);
    return () => document.removeEventListener("click", onDoc, true);
  }, [menuUid, bulkMenuOpen]);

  // emailLibrary.js global Ctrl/Cmd+A handler — while an email reader is open,
  // a select-all selects ONLY the reader body contents, not the whole page,
  // unless the keystroke originates in an editable field.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "a") return;
      const reader = readerRef.current;
      if (!reader?.isConnected) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(reader);
      sel.removeAllRanges();
      sel.addRange(range);
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  // Folder list: real IMAP folders would replace this; the single static "Inbox"
  // option is what odysseus shows before a folder fetch lands (emailLibrary.js).
  const folders = useMemo<{ value: string; label: string }[]>(
    () => [...INITIAL_FOLDERS],
    [],
  );

  // Resolve a message's effective done/read state through the local overrides.
  const isAnswered = useCallback(
    (m: EmailMessage): boolean => answeredOverride.get(m.uid) ?? m.isAnswered,
    [answeredOverride],
  );
  const isRead = useCallback(
    (m: EmailMessage): boolean => readOverride.get(m.uid) ?? m.isRead,
    [readOverride],
  );

  // No eliza client method backs a mail store (see file header) — the message
  // set is intentionally empty unless data is passed in, so the honest empty
  // state is the default. The filter pipeline below is wired against the typed
  // set so the list lights up unchanged once a backend exists.
  const visibleMessages = useMemo<EmailMessage[]>(() => {
    const q = search.trim().toLowerCase();
    const now = Date.now();
    const tagFilter = TAG_FILTERS.find((t) => t.value === filter);
    return messages.filter((m) => {
      const answered = answeredOverride.get(m.uid) ?? m.isAnswered;
      const read = readOverride.get(m.uid) ?? m.isRead;
      if (filter === "unread" && read) return false;
      if (filter === "favorites" && !m.isFlagged) return false;
      if (filter === "undone" && answered) return false;
      if (filter === "unanswered" && answered) return false;
      if (filter === "pending_30d" && now - m.date > THIRTY_DAYS_MS) {
        return false;
      }
      if (filter === "stale_30d" && now - m.date <= THIRTY_DAYS_MS) {
        return false;
      }
      if (tagFilter && !m.tags.some((t) => t.label === tagFilter.tag)) {
        return false;
      }
      if (undoneOnly && answered) return false;
      if (attachmentsOnly && !m.hasAttachments) return false;
      if (q.length > 0) {
        const hay =
          `${m.subject} ${m.fromName} ${m.fromAddress} ${m.body}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    messages,
    filter,
    search,
    undoneOnly,
    attachmentsOnly,
    answeredOverride,
    readOverride,
  ]);

  const remindPresets = useMemo<RemindPreset[]>(
    () => (remindSubmenuOpen ? buildRemindPresets(new Date()) : []),
    [remindSubmenuOpen],
  );

  const isSentFolder = /sent/i.test(folder);
  const isRemindersFilter = filter === "reminders";

  const unreadCount = messages.filter((m) => !isRead(m)).length;

  const startCompose = useCallback(() => {
    setComposing(true);
    setSelectedUid(null);
    setDraftTo("");
    setDraftSubject("");
    setDraftBody("");
  }, []);

  const closeCompose = useCallback(() => {
    setComposing(false);
    setDraftTo("");
    setDraftSubject("");
    setDraftBody("");
  }, []);

  const startReply = useCallback(
    (m: EmailMessage, mode: "reply" | "reply-all" | "forward") => {
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
    },
    [],
  );

  const insertSignature = useCallback((sig: SavedSignature) => {
    setDraftBody((b) => `${b}\n\n— ${sig.name}`);
    setSigPickerOpen(false);
  }, []);

  const persistSignatures = useCallback((next: SavedSignature[]) => {
    setSignatures(next);
    writePref(SIGNATURES_PREF_KEY, next);
  }, []);

  const deleteSignature = useCallback(
    (id: string) => {
      persistSignatures(signatures.filter((s) => s.id !== id));
    },
    [signatures, persistSignatures],
  );

  // emailLibrary.js doneCheck toggle — flip the visible state, optimistically,
  // and mark-read on done (mirrors mark-answered + mark-read).
  const toggleDone = useCallback(
    (m: EmailMessage) => {
      const next = !isAnswered(m);
      setAnsweredOverride((prev) => {
        const map = new Map(prev);
        map.set(m.uid, next);
        return map;
      });
      if (next) {
        setReadOverride((prev) => {
          const map = new Map(prev);
          map.set(m.uid, true);
          return map;
        });
      }
    },
    [isAnswered],
  );

  const setReadState = useCallback((uids: string[], read: boolean) => {
    setReadOverride((prev) => {
      const map = new Map(prev);
      for (const uid of uids) map.set(uid, read);
      return map;
    });
  }, []);

  const toggleSelect = useCallback((uid: string) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const enterSelect = useCallback((uid?: string) => {
    setSelectMode(true);
    if (uid) setSelectedUids((prev) => new Set(prev).add(uid));
    setMenuUid(null);
  }, []);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelectedUids(new Set());
    setBulkMenuOpen(false);
  }, []);

  const allSelected =
    visibleMessages.length > 0 &&
    visibleMessages.every((m) => selectedUids.has(m.uid));

  const toggleSelectAll = useCallback(() => {
    setSelectedUids((prev) => {
      const everySelected =
        visibleMessages.length > 0 &&
        visibleMessages.every((m) => prev.has(m.uid));
      if (everySelected) return new Set();
      return new Set(visibleMessages.map((m) => m.uid));
    });
  }, [visibleMessages]);

  const runBulk = useCallback(
    (action: "done" | "read" | "unread" | "archive" | "delete") => {
      const uids = Array.from(selectedUids);
      setBulkMenuOpen(false);
      if (uids.length === 0) return;
      if (action === "done") {
        // emailLibrary.js _bulkAction('done') — mark answered + read for the
        // selected uids (fully client-side via the optimistic overrides).
        setAnsweredOverride((prev) => {
          const map = new Map(prev);
          for (const uid of uids) map.set(uid, true);
          return map;
        });
        setReadState(uids, true);
      } else if (action === "read" || action === "unread") {
        setReadState(uids, action === "read");
      } else if (action === "archive") {
        onArchive?.(uids);
      } else if (action === "delete") {
        onDelete?.(uids);
      }
      exitSelect();
    },
    [selectedUids, setReadState, onArchive, onDelete, exitSelect],
  );

  const closeRowMenu = useCallback(() => {
    setMenuUid(null);
    setRemindSubmenuOpen(false);
  }, []);

  const sendDraft = useCallback(() => {
    if (!onSend) return;
    onSend({ to: draftTo, subject: draftSubject, body: draftBody });
    closeCompose();
  }, [onSend, draftTo, draftSubject, draftBody, closeCompose]);

  // Stats label — short queries collapse back to the list like
  // emailLibrary.js _doSearch.
  const statsLabel =
    visibleMessages.length === 1
      ? "1 email"
      : `${visibleMessages.length} emails`;

  if (!open) return null;
  if (win.minimized) return null;

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
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
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div className="od-search-panel od-email-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        {/* ── Header (emailLibrary.js modal-header) ── */}
        <div
          className="od-email-head od-window-header"
          onPointerDown={win.onDragStart}
        >
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
            {feedback ? (
              <span className="od-email-feedback" role="status">
                {feedback}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
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
          All emails. Click to open as a document.
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
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              role="img"
              aria-label="New email"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
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
                <option key={f.value} value={f.value}>
                  {f.label}
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
              <optgroup label="Tags">
                {TAG_FILTERS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            </select>
            <button
              type="button"
              className={`od-email-tbtn${selectMode ? " active" : ""}`}
              onClick={() => (selectMode ? exitSelect() : enterSelect())}
            >
              {selectMode ? "Cancel" : "Select"}
            </button>
            {onRefresh ? (
              <button
                type="button"
                className="od-email-tbtn"
                title="Refresh"
                aria-label="Refresh"
                onClick={onRefresh}
              >
                <RefreshCw size={12} />
              </button>
            ) : null}
            {isRemindersFilter && onClearReminders ? (
              <button
                type="button"
                className="od-email-tbtn"
                title="Permanently delete reminder emails"
                aria-label="Clear reminders"
                onClick={onClearReminders}
              >
                <Eraser size={12} />
                <span className="od-email-tbtn-label">Clear</span>
              </button>
            ) : null}
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
              {/* Inline quick-toggles, absolutely positioned inside the field
                  (emailLibrary.js lines 654-662: #email-reminder-btn /
                  #email-undone-btn / #email-attach-btn). The bell is hidden
                  until reminders are enabled (starts `hidden`). */}
              <span className="od-email-search-toggles">
                {remindersEnabled ? (
                  <button
                    type="button"
                    className={`od-email-inline-toggle${isRemindersFilter ? " active" : ""}`}
                    title="Show reminder emails"
                    aria-label="Show reminder emails"
                    aria-pressed={isRemindersFilter}
                    onClick={() =>
                      setFilter((f) =>
                        f === "reminders" ? "all" : "reminders",
                      )
                    }
                  >
                    <Bell size={12} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`od-email-inline-toggle${undoneOnly ? " active" : ""}`}
                  title="Show only emails not marked as done (undone)"
                  aria-label="Show only emails not marked as done"
                  aria-pressed={undoneOnly}
                  onClick={() => setUndoneOnly((v) => !v)}
                >
                  <Check size={12} />
                </button>
                <button
                  type="button"
                  className={`od-email-inline-toggle${attachmentsOnly ? " active" : ""}`}
                  title="Show only emails with attachments"
                  aria-label="Show only emails with attachments"
                  aria-pressed={attachmentsOnly}
                  onClick={() => setAttachmentsOnly((v) => !v)}
                >
                  <Paperclip size={12} />
                </button>
              </span>
            </span>
          </div>
          {/* ── Bulk bar (emailLibrary.js email-lib-bulk) ── */}
          {selectMode ? (
            <div className="od-email-bulk">
              <label className="od-email-bulk-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                />
                All
              </label>
              <span className="od-email-bulk-count">
                {selectedUids.size} Selected
              </span>
              <span className="od-email-menu-anchor od-email-bulk-actions-wrap">
                <button
                  type="button"
                  className="od-email-tbtn od-email-bulk-actions-btn"
                  disabled={selectedUids.size === 0}
                  onClick={() => setBulkMenuOpen((v) => !v)}
                >
                  <Menu size={11} />
                  <span>Actions</span>
                  <span className="od-email-bulk-caret" aria-hidden="true">
                    ▼
                  </span>
                </button>
                {bulkMenuOpen ? (
                  <div className="od-email-dropdown">
                    <button
                      type="button"
                      className="od-email-dropdown-item"
                      onClick={() => runBulk("done")}
                    >
                      <Check size={14} />
                      <span>Done</span>
                    </button>
                    <button
                      type="button"
                      className="od-email-dropdown-item"
                      onClick={() => runBulk("read")}
                    >
                      <Check size={14} />
                      <span>Mark Read</span>
                    </button>
                    <button
                      type="button"
                      className="od-email-dropdown-item"
                      onClick={() => runBulk("unread")}
                    >
                      <Bell size={14} />
                      <span>Mark Unread</span>
                    </button>
                    {onArchive ? (
                      <button
                        type="button"
                        className="od-email-dropdown-item"
                        onClick={() => runBulk("archive")}
                      >
                        <Archive size={14} />
                        <span>Archive</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </span>
              {onDelete ? (
                <button
                  type="button"
                  className="od-email-tbtn od-email-bulk-delete"
                  disabled={selectedUids.size === 0}
                  onClick={() => runBulk("delete")}
                >
                  <Trash2 size={12} />
                  <span className="od-email-tbtn-label">Delete</span>
                </button>
              ) : null}
              <button
                type="button"
                className="od-email-tbtn od-email-bulk-cancel"
                title="Cancel (Esc)"
                aria-label="Cancel selection"
                onClick={exitSelect}
              >
                <X size={12} />
              </button>
            </div>
          ) : null}
        </div>

        {/* ── Single-column card grid (emailLibrary.js #email-lib-grid
            .doclib-grid). odysseus has no inline reading pane: a card opens
            "as a document" by expanding in place to surface the reader
            (From/To/Cc + actions + body); compose opens the same way as an
            expanded compose card at the top of the grid. ── */}
        <div className="od-email-grid">
          {loading ? (
            <div className="od-email-loading">
              <Spinner label="Loading emails" />
            </div>
          ) : (
            <>
              {composing ? (
                <div className="od-email-card od-email-card-compose expanded">
                  <div className="od-email-compose">
                    <div className="od-email-compose-head">
                      <span className="od-email-compose-title">
                        New message
                      </span>
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
                        disabled={!draftTo.trim() || !onSend}
                        title={
                          onSend
                            ? "Send"
                            : "Email send has no eliza backend yet"
                        }
                        onClick={sendDraft}
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {accounts.length === 0 && messages.length === 0 ? (
                <div className="od-email-empty">
                  <span className="od-email-empty-title">
                    No emails
                    <Smile size={14} className="od-email-empty-smiley" />
                  </span>
                  <span className="od-email-empty-sub">
                    Set up at:{" "}
                    <span className="od-email-empty-link">
                      Settings › Integrations
                    </span>
                  </span>
                </div>
              ) : visibleMessages.length === 0 ? (
                <div className="od-email-empty od-email-empty-filtered">
                  <span className="od-email-empty-title">
                    No emails
                    <Smile size={14} className="od-email-empty-smiley" />
                  </span>
                </div>
              ) : (
                visibleMessages.map((m) => {
                  const senderName = isSentFolder
                    ? m.to || "(no recipient)"
                    : m.fromName || m.fromAddress;
                  const color = senderColor(senderName);
                  const dotColor = urgencyColor(m.urgency) || color;
                  const answered = isAnswered(m);
                  const read = isRead(m);
                  const isExpanded = !composing && m.uid === selectedUid;
                  const cls = [
                    "od-email-card",
                    answered ? "od-email-answered" : "",
                    !read ? "od-email-unread" : "",
                    isExpanded ? "expanded" : "",
                    selectedUids.has(m.uid) ? "od-email-row-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <div key={m.uid} className={cls}>
                      <div className="od-email-card-row">
                        {selectMode ? (
                          <input
                            type="checkbox"
                            className="od-email-row-check"
                            checked={selectedUids.has(m.uid)}
                            onChange={() => toggleSelect(m.uid)}
                            aria-label={`Select ${senderName}`}
                          />
                        ) : null}
                        <button
                          type="button"
                          className="od-email-item-open"
                          onClick={() => {
                            if (selectMode) {
                              toggleSelect(m.uid);
                              return;
                            }
                            setComposing(false);
                            setSelectedUid((prev) =>
                              prev === m.uid ? null : m.uid,
                            );
                          }}
                        >
                          {!selectMode ? (
                            <span
                              className="od-email-avatar"
                              style={{ background: color }}
                            >
                              {initial(senderName)}
                            </span>
                          ) : null}
                          <span className="od-email-item-content">
                            <span className="od-email-subject">
                              {m.subject || "(no subject)"}
                              {!read && !answered ? (
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
                            <span className="od-email-card-meta">
                              <span
                                className="od-email-sender"
                                style={{ color }}
                              >
                                {isSentFolder ? `to ${senderName}` : senderName}
                              </span>
                              <span className="od-email-meta-sep"> · </span>
                              <span className="od-email-date">
                                {formatListDate(m.date)}
                              </span>
                            </span>
                          </span>
                        </button>
                        {!isSentFolder ? (
                          <button
                            type="button"
                            className={`od-email-done${answered ? " active" : ""}`}
                            title={answered ? "Mark not done" : "Mark done"}
                            aria-label={
                              answered ? "Mark not done" : "Mark done"
                            }
                            aria-pressed={answered}
                            onClick={() => toggleDone(m)}
                          >
                            <Check size={13} />
                          </button>
                        ) : null}
                        {!selectMode ? (
                          <span className="od-email-item-menu od-email-menu-anchor">
                            <button
                              type="button"
                              className="od-email-item-menu-btn"
                              title="Actions"
                              aria-label="Email actions"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRemindSubmenuOpen(false);
                                setMenuUid((prev) =>
                                  prev === m.uid ? null : m.uid,
                                );
                              }}
                            >
                              <MoreVertical size={14} />
                            </button>
                            {menuUid === m.uid ? (
                              <div className="od-email-dropdown">
                                {remindSubmenuOpen && onRemind ? (
                                  <>
                                    <div className="od-email-dropdown-header">
                                      Remind me
                                    </div>
                                    {remindPresets.map((p) => (
                                      <button
                                        type="button"
                                        key={p.key}
                                        className="od-email-dropdown-item"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          onRemind(m.uid, p.date);
                                          closeRowMenu();
                                        }}
                                      >
                                        <span>{p.label}</span>
                                        <span className="od-email-dropdown-sub">
                                          {p.sub}
                                        </span>
                                      </button>
                                    ))}
                                  </>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="od-email-dropdown-item"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setComposing(false);
                                        setSelectedUid(m.uid);
                                        closeRowMenu();
                                      }}
                                    >
                                      <Reply size={14} />
                                      <span>Open</span>
                                    </button>
                                    {onRemind ? (
                                      <button
                                        type="button"
                                        className="od-email-dropdown-item"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setRemindSubmenuOpen(true);
                                        }}
                                      >
                                        <Bell size={14} />
                                        <span>Remind to reply</span>
                                        <span className="od-email-dropdown-arrow">
                                          ›
                                        </span>
                                      </button>
                                    ) : null}
                                    {!isSentFolder ? (
                                      <button
                                        type="button"
                                        className="od-email-dropdown-item"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleDone(m);
                                          closeRowMenu();
                                        }}
                                      >
                                        <Check size={14} />
                                        <span>
                                          {answered ? "Not Done" : "Done"}
                                        </span>
                                      </button>
                                    ) : null}
                                    {onArchive ? (
                                      <button
                                        type="button"
                                        className="od-email-dropdown-item"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          onArchive([m.uid]);
                                          closeRowMenu();
                                        }}
                                      >
                                        <Archive size={14} />
                                        <span>Archive</span>
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      className="od-email-dropdown-item"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        enterSelect(m.uid);
                                      }}
                                    >
                                      <span className="od-email-dropdown-bullet">
                                        ●
                                      </span>
                                      <span>Select</span>
                                    </button>
                                    {onDelete ? (
                                      <button
                                        type="button"
                                        className="od-email-dropdown-item od-email-dropdown-danger"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          onDelete([m.uid]);
                                          closeRowMenu();
                                        }}
                                      >
                                        <Trash2 size={14} />
                                        <span>Delete</span>
                                      </button>
                                    ) : null}
                                  </>
                                )}
                              </div>
                            ) : null}
                          </span>
                        ) : null}
                      </div>

                      {/* ── Expanded reader (emailLibrary.js doclib-card-expanded
                          → opens the message "as a document" inline) ── */}
                      {isExpanded ? (
                        <div className="od-email-reader" ref={readerRef}>
                          <div className="od-email-reader-header">
                            <div className="od-email-reader-meta">
                              <div className="od-email-reader-meta-row">
                                <strong>From:</strong>
                                <span className="od-email-recipient-chips">
                                  <RecipientChip
                                    full={`${m.fromName} <${m.fromAddress}>`}
                                    label={m.fromName || m.fromAddress}
                                    className="od-email-recipient-chip-from"
                                    onCopied={showCopied}
                                  />
                                </span>
                              </div>
                              {m.to ? (
                                <div className="od-email-reader-meta-row">
                                  <strong>To:</strong>
                                  <span className="od-email-recipient-chips">
                                    {splitRecipientList(m.to).map((a) => (
                                      <RecipientChip
                                        key={a}
                                        full={a}
                                        label={extractRecipientName(a)}
                                        onCopied={showCopied}
                                      />
                                    ))}
                                  </span>
                                </div>
                              ) : null}
                              {m.cc ? (
                                <div className="od-email-reader-meta-row">
                                  <strong>Cc:</strong>
                                  <span className="od-email-recipient-chips">
                                    {splitRecipientList(m.cc).map((a) => (
                                      <RecipientChip
                                        key={a}
                                        full={a}
                                        label={extractRecipientName(a)}
                                        onCopied={showCopied}
                                      />
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
                                onClick={() => startReply(m, "reply")}
                              >
                                <Reply size={14} />
                                <span className="od-email-reader-btn-label">
                                  Reply
                                </span>
                              </button>
                              <button
                                type="button"
                                className="od-email-reader-btn"
                                title="Reply all"
                                onClick={() => startReply(m, "reply-all")}
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
                                onClick={() => startReply(m, "forward")}
                              >
                                <Forward size={14} />
                                <span className="od-email-reader-btn-label">
                                  Forward
                                </span>
                              </button>
                              {onAiReply ? (
                                <button
                                  type="button"
                                  className="od-email-reader-btn"
                                  title="AI reply"
                                  onClick={() => onAiReply(m.uid)}
                                >
                                  <Sparkles size={14} />
                                  <span className="od-email-reader-btn-label">
                                    AI reply
                                  </span>
                                </button>
                              ) : null}
                              {onSummarize ? (
                                <button
                                  type="button"
                                  className="od-email-reader-btn"
                                  title="Summarize"
                                  onClick={() => onSummarize(m.uid)}
                                >
                                  <Search size={14} />
                                  <span className="od-email-reader-btn-label">
                                    Summary
                                  </span>
                                </button>
                              ) : null}
                            </div>
                          </div>
                          {m.isFlagged ? (
                            <div className="od-email-reader-subject">
                              <Star
                                size={13}
                                className="od-email-reader-star"
                              />
                            </div>
                          ) : null}
                          {m.attachments.length > 0 ? (
                            <div
                              className={`od-email-atts-wrap${attsExpanded ? "" : " collapsed"}`}
                            >
                              <button
                                type="button"
                                className="od-email-atts-header"
                                aria-expanded={attsExpanded}
                                onClick={() => setAttsExpanded((v) => !v)}
                              >
                                <Paperclip size={11} />
                                <span>
                                  Attachments ({m.attachments.length})
                                </span>
                                <svg
                                  className="od-email-atts-chevron"
                                  width="10"
                                  height="10"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <polyline points="6 9 12 15 18 9" />
                                </svg>
                              </button>
                              <div className="od-email-atts">
                                {m.attachments.map((att) => (
                                  <button
                                    type="button"
                                    key={att.index}
                                    className="od-email-att-chip"
                                    disabled={!onDownloadAttachment}
                                    title={
                                      onDownloadAttachment
                                        ? `Download ${att.filename}`
                                        : "Attachment download has no eliza backend yet"
                                    }
                                    onClick={() =>
                                      onDownloadAttachment?.(
                                        m.uid,
                                        att.index,
                                        att.filename,
                                      )
                                    }
                                  >
                                    <Paperclip size={12} />
                                    <span className="od-email-att-name">
                                      {att.filename}
                                    </span>
                                    <span className="od-email-att-size">
                                      {Math.round((att.size || 0) / 1024)} KB
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          <div className="od-email-reader-body">{m.body}</div>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </>
          )}

          {/* Floating compose button (emailLibrary.js #email-lib-fab). */}
          <button
            type="button"
            className="od-email-fab"
            onClick={startCompose}
            aria-label="New email"
            title="New email"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
              <path d="M3 6.5l9 6 9-6" />
            </svg>
            <span className="od-email-fab-label">New</span>
          </button>
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
            <button
              type="button"
              className="od-email-sig-new"
              onClick={() => {
                setSigPickerOpen(false);
                setSigCaptureOpen(true);
              }}
            >
              <PenLine size={13} />
              <span>Draw new signature</span>
            </button>
            {signatures.length === 0 ? (
              <div className="od-email-sig-empty">
                No saved signatures yet — draw one above.
              </div>
            ) : (
              <div className="od-email-sig-grid">
                {signatures.map((s) => (
                  <span key={s.id} className="od-email-sig-tile-wrap">
                    <button
                      type="button"
                      className="od-email-sig-tile"
                      onClick={() => insertSignature(s)}
                    >
                      <img src={s.dataUrl} alt={s.name} />
                      <span className="od-email-sig-name">{s.name}</span>
                    </button>
                    <button
                      type="button"
                      className="od-email-sig-del"
                      title="Delete signature"
                      aria-label={`Delete ${s.name}`}
                      onClick={() => deleteSignature(s.id)}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* ── Signature capture pad (signature.js capture) ── */}
      {sigCaptureOpen ? (
        <SignatureCapture
          onClose={() => setSigCaptureOpen(false)}
          onSave={(sig) => {
            persistSignatures([...signatures, sig]);
            setSigCaptureOpen(false);
            insertSignature(sig);
          }}
        />
      ) : null}
    </div>
  );
}

// signature.js capture() — a smoothing draw pad with a smoothness slider,
// undo/clear, and save. Saves persist via the parent's persistSignatures
// (localStorage, since eliza has no /api/signatures backend).
function SignatureCapture({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (sig: SavedSignature) => void;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SmoothPad | null>(null);
  const [smooth, setSmooth] = useState<number>(() =>
    readPref<number>(SIGNATURE_SMOOTH_PREF_KEY, 3),
  );
  const [name, setName] = useState("");
  const [empty, setEmpty] = useState(true);

  // Build the pad once from the canvas at mount. It starts at the persisted
  // smoothness (re-read here so this effect owns no reactive dependency); live
  // slider changes flow through the setSmoothness effect below.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    padRef.current = new SmoothPad(
      canvas,
      readPref<number>(SIGNATURE_SMOOTH_PREF_KEY, 3),
    );
    return () => {
      padRef.current = null;
    };
  }, []);

  useEffect(() => {
    padRef.current?.setSmoothness(smooth);
  }, [smooth]);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    padRef.current?.begin(e.nativeEvent);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.buttons === 0) return;
    padRef.current?.extend(e.nativeEvent);
  };
  const onPointerUp = () => {
    padRef.current?.end();
    setEmpty(padRef.current?.isEmpty() ?? true);
  };

  const onSmoothChange = (v: number) => {
    setSmooth(v);
    writePref(SIGNATURE_SMOOTH_PREF_KEY, v);
  };

  const clear = () => {
    padRef.current?.clear();
    setEmpty(true);
  };
  const undo = () => {
    padRef.current?.undo();
    setEmpty(padRef.current?.isEmpty() ?? true);
  };

  const save = () => {
    const pad = padRef.current;
    if (!pad || pad.isEmpty()) return;
    onSave({
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `sig-${Date.now()}`,
      name: name.trim() || "Signature",
      dataUrl: pad.toDataUrl(),
    });
  };

  return (
    <div
      className="od-email-sig-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Draw your signature"
    >
      <button
        type="button"
        className="od-search-backdrop"
        aria-label="Cancel signature"
        onClick={onClose}
      />
      <div className="od-email-sig-panel od-email-sig-capture">
        <div className="od-mem-head">
          <span className="od-mem-title">Draw your signature</span>
          <button
            type="button"
            className="od-email-tbtn"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
        <canvas
          ref={canvasRef}
          className="od-email-sig-canvas"
          width={900}
          height={280}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <div className="od-email-sig-smooth">
          <span className="od-email-sig-smooth-label">Smoothness</span>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={smooth}
            onChange={(e) => onSmoothChange(Number(e.target.value))}
            aria-label="Smoothness"
          />
          <span className="od-email-sig-smooth-val">{smooth}</span>
        </div>
        <input
          type="text"
          className="od-email-sig-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional, e.g. 'Full' or 'Initials')"
          aria-label="Signature name"
        />
        <div className="od-email-sig-footer">
          <button type="button" className="od-email-sig-btn" onClick={clear}>
            Clear
          </button>
          <button type="button" className="od-email-sig-btn" onClick={undo}>
            <RotateCcw size={12} />
            Undo
          </button>
          <span className="od-email-compose-spacer" />
          <button type="button" className="od-email-sig-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="od-email-send-btn"
            disabled={empty}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
