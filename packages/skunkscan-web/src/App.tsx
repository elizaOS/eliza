import { FormEvent, useState } from "react";

// Mirrors SUPPORTED_CHAINS in packages/agent/src/skunkscan/types.ts and the
// WalletTrustCheckCard shape in the same file - kept as a plain local copy
// rather than a cross-package import since this page has no build-time
// dependency on @elizaos/agent (it only talks to it over HTTP).
const SUPPORTED_CHAINS = ["solana", "ethereum", "base", "bnb", "bitcoin"] as const;
type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

type TrustCheckTier = "green" | "yellow" | "red";

type TrustCheckCard = {
  chain: SupportedChain;
  address: string;
  status: "supported" | "unsupported_chain" | "invalid_address" | "error";
  tier: TrustCheckTier | null;
  headline: string;
  reasons: string[];
  riskDisplay?: string;
  trustDisplay?: string;
  exposureDisplay?: string;
  warnings: string[];
};

const TIER_LABEL: Record<TrustCheckTier, string> = {
  green: "🟢 Low risk",
  yellow: "🟡 Review recommended",
  red: "🔴 High risk",
};

export function App() {
  const [chain, setChain] = useState<SupportedChain>("ethereum");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [card, setCard] = useState<TrustCheckCard | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = address.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setCard(null);

    try {
      const response = await fetch("/api/skunkscan/trust-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain, address: trimmed }),
      });
      const body = (await response.json()) as TrustCheckCard;

      if (!response.ok && body.status !== "supported") {
        setError(body.headline || "Could not check this wallet.");
        setCard(body);
        return;
      }

      setCard(body);
    } catch {
      setError("Something went wrong reaching SkunkScan. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.title}>SkunkScan Trust Check</h1>
      <p style={styles.subtitle}>
        Free wallet risk summary. Paste an address, pick a chain, and check.
      </p>

      <form onSubmit={handleSubmit} style={styles.form}>
        <select
          value={chain}
          onChange={(event) => setChain(event.target.value as SupportedChain)}
          style={styles.select}
          aria-label="Chain"
        >
          {SUPPORTED_CHAINS.map((chainOption) => (
            <option key={chainOption} value={chainOption}>
              {chainOption}
            </option>
          ))}
        </select>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="Wallet address"
          style={styles.input}
          aria-label="Wallet address"
        />
        <button type="submit" disabled={loading || !address.trim()} style={styles.button}>
          {loading ? "Checking..." : "Check"}
        </button>
      </form>

      {error && <p style={styles.error}>{error}</p>}

      {card && card.tier && (
        <section style={{ ...styles.card, ...tierCardStyle(card.tier) }}>
          <p style={styles.tierLabel}>{TIER_LABEL[card.tier]}</p>
          <h2 style={styles.headline}>{card.headline}</h2>

          {card.tier === "red" && card.reasons.length > 0 && (
            <ul style={styles.reasons}>
              {card.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          <dl style={styles.scores}>
            {card.riskDisplay && (
              <>
                <dt>Risk</dt>
                <dd>{card.riskDisplay}</dd>
              </>
            )}
            {card.trustDisplay && (
              <>
                <dt>Trust</dt>
                <dd>{card.trustDisplay}</dd>
              </>
            )}
            {card.exposureDisplay && (
              <>
                <dt>Exposure</dt>
                <dd>{card.exposureDisplay}</dd>
              </>
            )}
          </dl>
        </section>
      )}
    </main>
  );
}

function tierCardStyle(tier: TrustCheckTier): React.CSSProperties {
  switch (tier) {
    case "green":
      return { borderColor: "#2e7d32", background: "#f1f8f2" };
    case "yellow":
      return { borderColor: "#b28900", background: "#fffaf0" };
    case "red":
      return { borderColor: "#c62828", background: "#fdf2f2" };
  }
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    maxWidth: 560,
    margin: "0 auto",
    padding: "48px 20px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#1a1a1a",
  },
  title: { fontSize: 28, marginBottom: 4 },
  subtitle: { color: "#555", marginBottom: 24 },
  form: { display: "flex", gap: 8, flexWrap: "wrap" },
  select: { padding: "10px 8px", fontSize: 16 },
  input: { flex: 1, minWidth: 220, padding: "10px 12px", fontSize: 16 },
  button: {
    padding: "10px 20px",
    fontSize: 16,
    cursor: "pointer",
    background: "#1a1a1a",
    color: "#fff",
    border: "none",
  },
  error: { color: "#c62828", marginTop: 16 },
  card: {
    marginTop: 24,
    padding: 20,
    border: "2px solid",
    borderRadius: 8,
  },
  tierLabel: { fontWeight: 600, marginBottom: 4 },
  headline: { fontSize: 20, margin: "0 0 12px" },
  reasons: { margin: "0 0 12px", paddingLeft: 20 },
  scores: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: "4px 12px",
    fontSize: 14,
    color: "#333",
  },
};
