/**
 * The foreground Messages session of the AOSP telephony profile, shared by every host renderer that
 * shows device SMS/MMS through `createTelephonyClient` (`./native-telephony.ts`).
 *
 * Provider content, page cursors and the change observer exist only while the Messages surface is
 * in the foreground (`setActive(true)`). Leaving it clears every row and stops the observer, and an
 * old visit's late answer can never overwrite a newer one. A failed read is never presented as "no
 * messages", and missing SMS read access is reported as such. Holding the SMS role (the only app
 * Android lets keep read state), an opened conversation's shown incoming messages are marked read up
 * to the newest shown message; later arrivals stay unread and listing conversations never marks them.
 *
 * Receipt labels describe the shared `sms.send.v1` and `mms.send.v1` results without claiming more
 * than they prove: `submitted` is not a send and an MMS is never reported delivered.
 */

import type { MmsSendResult } from "./mms-send.ts";
import type {
  MmsReviewProblem,
  SmsMessage,
  SmsThread,
  TelephonyAccessKind,
  TelephonyClient,
  TelephonyStatus,
} from "./native-telephony.ts";
import type { SmsSendResult } from "./sms-send.ts";

/** The part of the telephony client a Messages session reads. */
export type SmsSessionClient = Pick<
  TelephonyClient,
  | "status"
  | "smsSendHistory"
  | "threadPage"
  | "messagePage"
  | "observeMessages"
  | "markThreadRead"
  | "requestAccess"
>;

export interface SmsSessionState {
  receipts: SmsSendResult[];
  rows: SmsMessage[];
  threads: SmsThread[];
  thread: string | null;
  status: TelephonyStatus | null;
  next: string | null;
  busy: boolean;
  message: string;
}

export interface SmsSessionMessages {
  idle: string;
  noAccess: string;
  found: string;
  empty: string;
  unreadable: string;
}

export const SMS_SESSION_MESSAGES: SmsSessionMessages = {
  idle: "Choose SMS access to read messages.",
  noAccess: "SMS read access has not been granted.",
  found: "Device messages. MMS attachments open in your messaging app.",
  empty: "No messages found.",
  unreadable:
    "Messages could not be read completely. Check access or use your system messaging app.",
};

export interface SmsSessionOptions {
  /** A send record changed; read it with `smsSendResult` for the review it belongs to. */
  onSendUpdated?: (operationId: string) => void;
  /** An MMS send record changed; read it with `mmsSendResult` for the review it belongs to. */
  onMmsSendUpdated?: (operationId: string) => void;
  /** Status lines shown for the session. Defaults to {@link SMS_SESSION_MESSAGES}. */
  messages?: Partial<SmsSessionMessages>;
}

export interface SmsSession {
  readonly state: SmsSessionState;
  /** Re-reads status, receipts and the current page; `more` follows the current page's cursor. */
  refresh(more?: boolean): Promise<void>;
  /** Opens one conversation, or the conversation list with null. */
  openThread(id: string | null): void;
  /** Foreground on/off. Off clears all provider content and stops observing. */
  setActive(value: boolean): void;
  /** Asks Android for one access, then re-reads the current visit. */
  request(access: TelephonyAccessKind): Promise<void>;
}

/**
 * @param admitted false off the admitted AOSP profile: the session then never calls the client.
 * @param onChange called whenever `state` changes.
 */
export function createSmsSession(
  client: SmsSessionClient,
  admitted: boolean,
  onChange: () => void,
  options: SmsSessionOptions = {},
): SmsSession {
  const text = { ...SMS_SESSION_MESSAGES, ...options.messages };
  let epoch = 0;
  let visit = 0;
  let observing = false;
  let active = false;
  let stop: (() => Promise<void>) | null = null;
  let observerTail: Promise<void> = Promise.resolve();
  const state: SmsSessionState = {
    receipts: [],
    rows: [],
    threads: [],
    thread: null,
    status: null,
    next: null,
    busy: false,
    message: text.idle,
  };

  function observe() {
    if (
      !active ||
      observing ||
      stop ||
      state.status?.permissions.sms !== "granted"
    )
      return;
    observing = true;
    const token = visit;
    // A previous visit's stop runs before this visit starts observing.
    observerTail = observerTail
      .then(async () => {
        if (!active || token !== visit) return;
        const dispose = await client.observeMessages(
          () => void refresh(),
          options.onSendUpdated,
          options.onMmsSendUpdated,
        );
        if (!active || token !== visit) await dispose();
        else stop = dispose;
      })
      .catch(() => {})
      .finally(() => {
        if (token === visit) observing = false;
      });
  }

  function markShown(
    thread: string,
    rows: SmsMessage[],
    status: TelephonyStatus,
  ) {
    if (
      !status.roles?.sms?.held ||
      !rows.some((row) => row.direction === "incoming" && !row.read)
    )
      return;
    const through = Math.max(...rows.map((row) => row.date));
    if (Number.isSafeInteger(through) && through > 0)
      void Promise.resolve()
        .then(() => client.markThreadRead(thread, through))
        .catch(() => {});
  }

  async function refresh(more = false) {
    if (!admitted || !active) return;
    const token = ++epoch;
    state.busy = true;
    onChange();
    try {
      const status = await client.status();
      if (token !== epoch || !active) return;
      state.status = status;
      const receipts = await client.smsSendHistory();
      if (token !== epoch || !active) return;
      state.receipts = receipts;
      if (status.permissions.sms !== "granted") {
        state.rows = [];
        state.threads = [];
        state.next = null;
        state.message = text.noAccess;
        return;
      }
      const cursor = more && state.next ? state.next : undefined;
      if (state.thread) {
        const page = await client.messagePage(state.thread, cursor);
        if (token !== epoch || !active) return;
        state.rows = page.rows;
        state.next = page.next;
        markShown(state.thread, page.rows, status);
      } else {
        const page = await client.threadPage(cursor);
        if (token !== epoch || !active) return;
        state.threads = page.rows;
        state.next = page.next;
      }
      state.message = (state.thread ? state.rows.length : state.threads.length)
        ? text.found
        : text.empty;
    } catch {
      if (token === epoch) {
        state.receipts = [];
        state.rows = [];
        state.threads = [];
        state.next = null;
        state.status = null;
        state.message = text.unreadable;
      }
    } finally {
      if (token === epoch) {
        state.busy = false;
        onChange();
        observe();
      }
    }
  }

  return {
    state,
    refresh,
    openThread(id) {
      epoch++;
      state.thread = id;
      state.rows = [];
      state.threads = [];
      state.next = null;
      void refresh();
    },
    setActive(value) {
      if (active === value) return;
      active = value;
      ++epoch;
      ++visit;
      if (value) {
        void refresh();
        return;
      }
      const dispose = stop;
      stop = null;
      if (dispose) observerTail = observerTail.then(dispose).catch(() => {});
      observing = false;
      state.receipts = [];
      state.rows = [];
      state.threads = [];
      state.thread = null;
      state.status = null;
      state.next = null;
      state.busy = false;
      onChange();
    },
    async request(access) {
      if (!admitted || !active) return;
      const token = epoch;
      await client.requestAccess(access);
      if (active && token === epoch) await refresh();
    },
  };
}

/** What a `sms.send.v1` result proves, in words. */
export function smsReceiptLabel(status: SmsSendResult["status"]): string {
  return {
    cancelled: "Cancelled — not sent",
    denied: "Access changed — not sent",
    failed:
      "Failure reported; some parts may have sent. Do not repeat automatically.",
    unknown: "Outcome unknown. Check the recipient before sending again.",
    submitted: "Submitted to Android; sending and delivery are not confirmed.",
    sent: "All parts sent; delivery is not confirmed.",
    delivered: "All parts have delivery confirmation.",
  }[status];
}

/** What a `mms.send.v1` result proves. MMS has no delivery claim: "sent" is the carrier's send confirmation only. */
export function mmsReceiptLabel(status: MmsSendResult["status"]): string {
  return {
    cancelled: "Cancelled — MMS not sent",
    denied: "Access changed — MMS not sent",
    failed:
      "Android or the carrier refused this MMS. Nothing is resent automatically.",
    unknown:
      "MMS outcome unknown. Check the conversation before sending again.",
    submitted: "MMS submitted to Android; the carrier has not confirmed it.",
    sent: "The carrier accepted the MMS; delivery is not confirmed.",
  }[status];
}

/**
 * Why `reviewMms` refused a draft, in words.
 * @param appName how the host names itself where MMS is unavailable (for example the product name).
 */
export function mmsProblemLabel(
  problem: MmsReviewProblem,
  appName = "this app",
): string {
  return {
    "no-recipient": "Enter at least one phone number.",
    "invalid-recipient": "Check the phone numbers.",
    "too-many-recipients": "An MMS can go to at most ten people.",
    "empty-body": "Enter a message or add a picture.",
    "empty-message": "Enter a message or add a picture.",
    "body-too-long": "MMS text is limited to 1,600 characters.",
    "invalid-body": "The message contains characters that cannot be sent.",
    "sim-unknown": "No active SIM is available.",
    "sim-required": "Select a SIM for this MMS.",
    "sim-not-selectable": "Select a SIM for this MMS.",
    "too-many-attachments": "An MMS can carry at most five pictures.",
    "attachment-type": "Only JPEG, PNG and GIF pictures can be sent.",
    "attachment-name": "A picture could not be named for sending.",
    "attachment-empty": "A picture is empty.",
    "too-large": "The pictures are larger than an MMS allows (1 MB in total).",
    "mms-unavailable": `This phone cannot send MMS from ${appName}. Use Review in messaging app.`,
  }[problem];
}
