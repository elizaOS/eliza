/** Blooio message delivery only: no agent runtime, logging, history or credential discovery. */
const MESSAGES_URL = "https://api.blooio.com/v4/messages";
const CHATS_URL = "https://api.blooio.com/v4/chats";
const MAX_RECEIPT_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 30_000;
export interface BlooioSendResult {
  success: boolean;
  messageId?: string;
  chatId?: string;
  error?: string;
}
async function readReceipt(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !response.body ||
    Number(response.headers.get("content-length")) > MAX_RECEIPT_BYTES
  )
    throw new Error("Invalid receipt");
  const reader = response.body.getReader();
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RECEIPT_BYTES) throw new Error("Invalid receipt");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function sendBlooioMessage(input: {
  apiKey: string;
  from: string;
  to: string;
  text: string;
  idempotencyKey: string;
}): Promise<BlooioSendResult> {
  if (
    !input.apiKey.trim() ||
    !input.from.trim() ||
    !input.to.trim() ||
    !input.idempotencyKey.trim()
  )
    return { success: false, error: "Blooio delivery is not configured" };
  const chatId = input.to.startsWith("chat_id:")
    ? input.to.slice("chat_id:".length)
    : null;
  const url = chatId
    ? `${CHATS_URL}/${encodeURIComponent(chatId)}/messages`
    : MESSAGES_URL;
  let response: Response | undefined;
  try {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify(
        chatId
          ? { text: input.text }
          : { to: input.to, from: input.from, text: input.text },
      ),
      signal,
    });
    if (!response.ok)
      return { success: false, error: "Blooio delivery was rejected" };
    const receipt = await readReceipt(response, signal);
    const record =
      receipt && typeof receipt === "object" && !Array.isArray(receipt)
        ? (receipt as Record<string, unknown>)
        : {};
    if (
      record.success === false ||
      (record.error !== undefined && record.error !== null)
    )
      return {
        success: false,
        error: "Blooio acceptance could not be verified",
      };
    const messageId =
      typeof record.id === "string"
        ? record.id
        : typeof record.message_id === "string"
          ? record.message_id
          : undefined;
    if (
      !messageId?.trim() ||
      messageId.length > 256 ||
      [...messageId].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return {
        success: false,
        error: "Blooio acceptance could not be verified",
      };
    return {
      success: true,
      messageId: messageId.trim(),
      chatId: chatId ?? input.to,
    };
  } catch {
    // Provider/transport exceptions may echo the OTP, phone or credential.
    return { success: false, error: "Blooio delivery failed" };
  } finally {
    if (response && !response.bodyUsed)
      void response.body?.cancel().catch(() => {});
  }
}
