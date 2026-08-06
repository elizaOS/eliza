import { loadPaymentSettings } from "../utils/settings";
import { WalletManager } from "../wallet/manager";
import { createX402Fetch } from "./agentkit-loader";
import { type BrinScanResult, scanUrl } from "./brin";
import { PaymentHistory } from "./history";
import type { PaymentInspectionResult, PaymentOption } from "./types";

interface RequestArgs {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
}

interface PaidRequestArgs extends RequestArgs {}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getAmountLabel(option: PaymentOption): string {
  return option.amount ?? option.maxAmountRequired ?? option.price ?? "0";
}

function parsePaymentTerms(response: Response): {
  accepts: PaymentOption[];
  description?: string;
} | null {
  const header = response.headers.get("payment-required");
  if (header) {
    try {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
      return {
        accepts: decoded.accepts ?? [],
        description: decoded.resource?.description ?? decoded.description,
      };
    } catch {
      // fall through
    }
  }
  return null;
}

export class X402Service {
  private readonly settings = loadPaymentSettings();
  private readonly walletManager = new WalletManager();
  private readonly history = new PaymentHistory();

  private ensureEnabled(): void {
    if (!this.settings.enabled) {
      throw new Error("Payments are disabled. Enable them in ~/.clawd/user-settings.json.");
    }
    if (!WalletManager.exists()) {
      throw new Error("No wallet found. Run `grok wallet init` first.");
    }
  }

  async fetchPaymentInfo(args: RequestArgs): Promise<PaymentInspectionResult> {
    this.ensureEnabled();
    const method = args.method ?? "GET";

    const brin = await scanUrl(args.url);

    const response = await fetch(args.url, {
      method,
      headers: args.headers,
      body: method !== "GET" ? args.body : undefined,
    });

    if (response.status !== 402) {
      const data = await response.text();
      return {
        requiresPayment: false,
        url: args.url,
        method,
        status: response.status,
        options: [],
        data,
        brin,
      };
    }

    const terms = parsePaymentTerms(response);
    return {
      requiresPayment: true,
      url: args.url,
      method,
      status: 402,
      options: terms?.accepts ?? [],
      description: terms?.description,
      brin,
    };
  }

  async paidRequest(args: PaidRequestArgs, sessionId?: string): Promise<{ success: boolean; output: string }> {
    this.ensureEnabled();
    const method = args.method ?? "GET";

    const brin = await scanUrl(args.url);
    if (brin && brin.score < 25) {
      const threatLines = (brin.threats ?? []).map((t) => `  [${t.severity}] ${t.type}: ${t.detail}`);
      this.history.record({
        id: crypto.randomUUID(),
        sessionId: sessionId ?? null,
        url: args.url,
        domain: getDomain(args.url),
        method,
        chain: this.settings.chain,
        network: "n/a",
        asset: "n/a",
        amount: "0",
        txHash: null,
        status: "blocked_by_brin",
        createdAt: new Date().toISOString(),
      });
      return {
        success: false,
        output: [
          `Payment BLOCKED — brin scored this URL ${brin.score}/100 (${brin.verdict}).`,
          `Domain: ${getDomain(args.url)}`,
          ...(threatLines.length > 0 ? ["Threats detected:", ...threatLines] : []),
          "",
          "This URL is considered unsafe. The transaction was not signed.",
        ].join("\n"),
      };
    }

    const probeResponse = await fetch(args.url, {
      method,
      headers: args.headers,
      body: method !== "GET" ? args.body : undefined,
    });

    if (probeResponse.status !== 402) {
      return { success: true, output: await probeResponse.text() };
    }

    const terms = parsePaymentTerms(probeResponse);
    const options = terms?.accepts ?? [];
    if (options.length === 0) {
      return {
        success: false,
        output: "Server returned 402 but no payment options were found.",
      };
    }

    const selected = options[0]!;
    const amount = getAmountLabel(selected);

    const stored = this.walletManager.getStoredWallet();
    const x402Fetch = await createX402Fetch(stored.privateKey, stored.chain);

    const paidResponse = await x402Fetch(args.url, {
      method,
      headers: args.headers,
      body: method !== "GET" ? args.body : undefined,
    });

    const responseText = await paidResponse.text();
    const success = paidResponse.ok;

    const paymentResponseHeader =
      paidResponse.headers.get("payment-response") ?? paidResponse.headers.get("x-payment-response");
    let txHash: string | null = null;
    if (paymentResponseHeader) {
      try {
        const proof = JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString("utf-8"));
        txHash = proof.transaction ?? proof.txHash ?? proof.tx_hash ?? proof.hash ?? null;
      } catch {
        // ignore
      }
    }

    this.history.record({
      id: crypto.randomUUID(),
      sessionId: sessionId ?? null,
      url: args.url,
      domain: getDomain(args.url),
      method,
      chain: this.settings.chain,
      network: selected.network,
      asset: selected.asset,
      amount,
      txHash,
      status: success ? "success" : "failed",
      createdAt: new Date().toISOString(),
    });

    const lines = [responseText];
    if (txHash) {
      lines.push(`\nTransaction: ${txHash}`);
    }

    return { success, output: lines.join("") };
  }
}

function formatBrinLines(brin: BrinScanResult): string[] {
  const lines: string[] = [`Security: ${brin.score}/100 (${brin.verdict}, ${brin.confidence} confidence)`];

  if (brin.subScores) {
    const parts: string[] = [];
    if (brin.subScores.identity !== null) parts.push(`Identity: ${brin.subScores.identity}`);
    if (brin.subScores.behavior !== null) parts.push(`Behavior: ${brin.subScores.behavior}`);
    if (brin.subScores.content !== null) parts.push(`Content: ${brin.subScores.content}`);
    if (brin.subScores.graph !== null) parts.push(`Graph: ${brin.subScores.graph}`);
    if (parts.length > 0) lines.push(`  ${parts.join(" | ")}`);
  }

  if (brin.threats && brin.threats.length > 0) {
    for (const t of brin.threats) {
      lines.push(`  [${t.severity}] ${t.type}: ${t.detail}`);
    }
  }

  return lines;
}

export function formatInspectionOutput(inspection: PaymentInspectionResult): string {
  if (!inspection.requiresPayment) {
    const base = typeof inspection.data === "string" ? inspection.data : JSON.stringify(inspection.data ?? {});
    if (inspection.brin) {
      return [base, "", ...formatBrinLines(inspection.brin)].join("\n");
    }
    return base;
  }
  const lines = inspection.options.map((option, i) => {
    const amount = getAmountLabel(option);
    return `${i + 1}. ${amount} via ${option.network} (${option.asset})${option.payTo ? ` -> ${option.payTo}` : ""}`;
  });
  return [
    "Payment required (402).",
    ...(inspection.description ? [`Description: ${inspection.description}`] : []),
    ...lines,
    ...(inspection.brin ? ["", ...formatBrinLines(inspection.brin)] : []),
  ].join("\n");
}
