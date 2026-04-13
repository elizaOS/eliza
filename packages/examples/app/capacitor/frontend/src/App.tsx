import React, { useEffect, useMemo, useState } from "react";
import { fetchGreeting, fetchHistory, resetChat, sendChat } from "./api";
import { loadConfig, saveConfig } from "./storage";
import {
  DEFAULT_CONFIG,
  getModeLabel,
  type AppConfig,
  type ChatMessage,
  type ProviderMode,
} from "./types";

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function now(): number {
  return Date.now();
}

function updateProvider(
  config: AppConfig,
  patch: Partial<AppConfig["provider"]>,
): AppConfig {
  return { ...config, provider: { ...config.provider, ...patch } };
}

export function App(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [effectiveMode, setEffectiveMode] = useState<ProviderMode>("elizaClassic");

  const backendUrl = useMemo(() => {
    const env = import.meta.env.VITE_CHAT_BACKEND_URL as string | undefined;
    return env && env.trim().length > 0 ? env : "http://localhost:8787";
  }, []);

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const history = await fetchHistory(config);
        if (cancelled) return;
        if (history.length > 0) {
          setMessages(history);
          return;
        }
        const greeting = await fetchGreeting(config);
        if (cancelled) return;
        setMessages([
          {
            id: newId(),
            role: "system",
            text: greeting,
            timestamp: now(),
          },
        ]);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setMessages([
          {
            id: newId(),
            role: "system",
            text: `Backend not reachable at ${backendUrl}. Start it with: bun run dev (in examples/app/capacitor/backend)\n\n${msg}`,
            timestamp: now(),
          },
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backendUrl, config]);

  const mode = config.mode;

  async function onSend(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setInput("");
    const userMsg: ChatMessage = {
      id: newId(),
      role: "user",
      text,
      timestamp: now(),
    };
    setMessages((m) => [...m, userMsg]);
    try {
      const res = await sendChat(config, text);
      setEffectiveMode(res.effectiveMode);
      const assistantMsg: ChatMessage = {
        id: newId(),
        role: "assistant",
        text: res.responseText,
        timestamp: now(),
      };
      setMessages((m) => [...m, assistantMsg]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((m) => [
        ...m,
        { id: newId(), role: "system", text: `Error: ${msg}`, timestamp: now() },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function onReset(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await resetChat(config);
      const greeting = await fetchGreeting(config);
      setMessages([{ id: newId(), role: "system", text: greeting, timestamp: now() }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <div className="title">ElizaOS Chat (Capacitor example)</div>
          <div className="subtitle">
            Backend: <code>{backendUrl}</code>
          </div>
        </div>
        <button className="btn" onClick={onReset} disabled={busy}>
          Reset
        </button>
      </header>

      <section className="panel">
        <div className="row">
          <label className="label">
            Provider
            <select
              className="select"
              value={config.mode}
              onChange={(e) => {
                const next = e.target.value as ProviderMode;
                setConfig((c) => ({ ...c, mode: next }));
              }}
              disabled={busy}
            >
              {(
                [
                  "elizaClassic",
                  "openai",
                  "anthropic",
                  "gemini",
                  "groq",
                  "openrouter",
                  "ollama",
                  "xai",
                ] as const
              ).map((m) => (
                <option key={m} value={m}>
                  {getModeLabel(m)}
                </option>
              ))}
            </select>
          </label>

          <div className="hint">
            Effective mode: <b>{getModeLabel(effectiveMode)}</b>
          </div>
        </div>

        {mode === "openai" ? (
          <div className="grid">
            <label className="label">
              OpenAI API key
              <input
                className="input"
                value={config.provider.openaiApiKey}
                placeholder="sk-..."
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { openaiApiKey: e.target.value }))
                }
              />
            </label>
            <label className="label">
              Base URL
              <input
                className="input"
                value={config.provider.openaiBaseUrl}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { openaiBaseUrl: e.target.value }))
                }
              />
            </label>
            <label className="label">
              Small model
              <input
                className="input"
                value={config.provider.openaiSmallModel}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { openaiSmallModel: e.target.value }))
                }
              />
            </label>
            <label className="label">
              Large model
              <input
                className="input"
                value={config.provider.openaiLargeModel}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { openaiLargeModel: e.target.value }))
                }
              />
            </label>
          </div>
        ) : null}

        {mode === "anthropic" ? (
          <div className="grid">
            <label className="label">
              Anthropic API key
              <input
                className="input"
                value={config.provider.anthropicApiKey}
                placeholder="sk-ant-..."
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { anthropicApiKey: e.target.value }),
                  )
                }
              />
            </label>
            <label className="label">
              Small model
              <input
                className="input"
                value={config.provider.anthropicSmallModel}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { anthropicSmallModel: e.target.value }),
                  )
                }
              />
            </label>
            <label className="label">
              Large model
              <input
                className="input"
                value={config.provider.anthropicLargeModel}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { anthropicLargeModel: e.target.value }),
                  )
                }
              />
            </label>
          </div>
        ) : null}

        {mode === "gemini" ? (
          <div className="grid">
            <label className="label">
              Google GenAI API key
              <input
                className="input"
                value={config.provider.googleGenaiApiKey}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { googleGenaiApiKey: e.target.value }),
                  )
                }
              />
            </label>
            <label className="label">
              Small model
              <input
                className="input"
                value={config.provider.googleSmallModel}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { googleSmallModel: e.target.value }),
                  )
                }
              />
            </label>
            <label className="label">
              Large model
              <input
                className="input"
                value={config.provider.googleLargeModel}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { googleLargeModel: e.target.value }),
                  )
                }
              />
            </label>
          </div>
        ) : null}

        {mode === "groq" ? (
          <div className="grid">
            <label className="label">
              Groq API key
              <input
                className="input"
                value={config.provider.groqApiKey}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { groqApiKey: e.target.value }))
                }
              />
            </label>
            <label className="label">
              Base URL
              <input
                className="input"
                value={config.provider.groqBaseUrl}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { groqBaseUrl: e.target.value }))
                }
              />
            </label>
            <label className="label">
              Small model
              <input
                className="input"
                value={config.provider.groqSmallModel}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { groqSmallModel: e.target.value }))
                }
              />
            </label>
            <label className="label">
              Large model
              <input
                className="input"
                value={config.provider.groqLargeModel}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { groqLargeModel: e.target.value }))
                }
              />
            </label>
          </div>
        ) : null}

        {mode === "openrouter" ? (
          <div className="grid">
            <label className="label">
              OpenRouter API key
              <input
                className="input"
                value={config.provider.openrouterApiKey}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { openrouterApiKey: e.target.value }),
                  )
                }
              />
            </label>
            <label className="label">
              Base URL
              <input
                className="input"
                value={config.provider.openrouterBaseUrl}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { openrouterBaseUrl: e.target.value }),
                  )
                }
              />
            </label>
            <label className="label">
              Small model
              <input
                className="input"
                value={config.provider.openrouterSmallModel}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { openrouterSmallModel: e.target.value }),
                  )
                }
              />
            </label>
            <label className="label">
              Large model
              <input
                className="input"
                value={config.provider.openrouterLargeModel}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { openrouterLargeModel: e.target.value }),
                  )
                }
              />
            </label>
          </div>
        ) : null}

        {mode === "ollama" ? (
          <div className="grid">
            <label className="label">
              Ollama endpoint
              <input
                className="input"
                value={config.provider.ollamaApiEndpoint}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { ollamaApiEndpoint: e.target.value }),
                  )
                }
              />
            </label>
            <label className="label">
              Small model
              <input
                className="input"
                value={config.provider.ollamaSmallModel}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { ollamaSmallModel: e.target.value }),
                  )
                }
              />
            </label>
            <label className="label">
              Large model
              <input
                className="input"
                value={config.provider.ollamaLargeModel}
                onChange={(e) =>
                  setConfig((c) =>
                    updateProvider(c, { ollamaLargeModel: e.target.value }),
                  )
                }
              />
            </label>
          </div>
        ) : null}

        {mode === "xai" ? (
          <div className="grid">
            <label className="label">
              xAI API key
              <input
                className="input"
                value={config.provider.xaiApiKey}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { xaiApiKey: e.target.value }))
                }
              />
            </label>
            <label className="label">
              Base URL
              <input
                className="input"
                value={config.provider.xaiBaseUrl}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { xaiBaseUrl: e.target.value }))
                }
              />
            </label>
            <label className="label">
              Small model
              <input
                className="input"
                value={config.provider.xaiSmallModel}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { xaiSmallModel: e.target.value }))
                }
              />
            </label>
            <label className="label">
              Large model
              <input
                className="input"
                value={config.provider.xaiLargeModel}
                onChange={(e) =>
                  setConfig((c) => updateProvider(c, { xaiLargeModel: e.target.value }))
                }
              />
            </label>
          </div>
        ) : null}
      </section>

      <main className="chat">
        {messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}`}>
            <div className="msg__meta">
              <span className="msg__role">{m.role}</span>
              <span className="msg__time">
                {new Date(m.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="msg__text">{m.text}</div>
          </div>
        ))}
      </main>

      <footer className="composer">
        <input
          className="input composer__input"
          value={input}
          placeholder="Type a message…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onSend();
          }}
          disabled={busy}
        />
        <button className="btn btn--primary" onClick={onSend} disabled={busy}>
          Send
        </button>
      </footer>
    </div>
  );
}

