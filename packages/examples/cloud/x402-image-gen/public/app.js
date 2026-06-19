// PayPerPixel front-end: drives the x402 quote → settle → image flow and shows
// the creator's live earnings. Vanilla JS, no build step.

const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => `$${Number(n ?? 0).toFixed(2)}`;

let pendingPrompt = "";
let pendingPaymentId = "";

function setStatus(message, kind = "") {
  const line = $("status-line");
  line.textContent = message;
  line.className = `hint${kind ? ` ${kind}` : ""}`;
}

async function loadConfig() {
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    $("price").textContent = `· ${fmtUsd(cfg.price_usd)}`;
    $("foot-config").textContent = `Eliza Cloud example · ${cfg.network} · ${cfg.currency} · app ${
      cfg.app_id ? cfg.app_id.slice(0, 8) : "unconfigured"
    }`;
    if (!cfg.configured) {
      setStatus("Server is missing ELIZAOS_CLOUD_API_KEY / ELIZA_APP_ID.", "error");
      $("generate").disabled = true;
    }
  } catch {
    /* config is best-effort */
  }
}

async function requestQuote() {
  const prompt = $("prompt").value.trim();
  if (!prompt) {
    setStatus("Enter a prompt first.", "error");
    return;
  }
  $("generate").disabled = true;
  setStatus("Creating payment request…");
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (res.status !== 402) {
      throw new Error(data?.error?.message ?? "Could not create a payment request.");
    }
    pendingPrompt = prompt;
    pendingPaymentId = data.paymentRequestId;
    $("pay-amount").textContent = `${fmtUsd(data.totalChargedUsd ?? data.amountUsd)} USDC`;
    $("pay-network").textContent = data.network;
    $("pay-to").textContent = data.payTo;
    $("pay-id").textContent = data.paymentRequestId;
    $("pay").hidden = false;
    $("result").hidden = true;
    setStatus("Payment required — settle the x402 request to continue.", "ok");
    $("pay").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    $("generate").disabled = false;
  }
}

async function settleAndReveal() {
  const raw = $("payload").value.trim();
  if (!raw) {
    setStatus("Paste the settled x402 payment payload.", "error");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    setStatus("Payment payload is not valid JSON.", "error");
    return;
  }
  $("settle").disabled = true;
  setStatus("Settling payment and generating…");
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: pendingPrompt,
        paymentRequestId: pendingPaymentId,
        paymentPayload: payload,
      }),
    });
    const data = await res.json();
    if (res.status !== 200) {
      throw new Error(data?.error?.message ?? "Generation failed.");
    }
    const src = data.image?.url || data.image?.image;
    $("image").src = src;
    $("receipt").textContent = `tx ${data.transaction ?? "—"} · paid ${fmtUsd(data.paidUsd)}`;
    $("result").hidden = false;
    $("pay").hidden = true;
    $("payload").value = "";
    setStatus("Image delivered. The creator just earned from your payment.", "ok");
    loadEarnings();
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    $("settle").disabled = false;
  }
}

async function loadEarnings() {
  try {
    const data = await fetch("/api/earnings").then((r) => r.json());
    const e = data.earnings ?? {};
    $("e-lifetime").textContent = fmtUsd(e.totalLifetimeEarnings ?? e.total_lifetime_earnings);
    $("e-withdrawable").textContent = fmtUsd(e.withdrawableBalance ?? e.withdrawable_balance);
    $("e-purchase").textContent = fmtUsd(e.totalPurchaseEarnings ?? e.total_purchase_earnings);
  } catch {
    /* earnings panel is best-effort */
  }
}

$("generate").addEventListener("click", requestQuote);
$("settle").addEventListener("click", settleAndReveal);
$("refresh-earnings").addEventListener("click", loadEarnings);

loadConfig();
loadEarnings();
