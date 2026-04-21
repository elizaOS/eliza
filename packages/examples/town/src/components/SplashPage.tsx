import { useState } from "react";
import {
  isProviderConfigured,
  type ModelSettings,
} from "../runtime/modelSettings";
import ModelSettingsPanel from "./ModelSettings";

type SplashPageProps = {
  settings: ModelSettings;
  onEnter: () => void;
};

export default function SplashPage({ settings, onEnter }: SplashPageProps) {
  const [showSettings, setShowSettings] = useState(true);
  const providerReady = isProviderConfigured(settings);

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center game-background font-body p-4">
      <div className="max-w-3xl w-full space-y-6">
        {/* Title */}
        <div className="text-center space-y-2">
          <h1 className="text-5xl sm:text-7xl font-display game-title tracking-wider">
            Eliza Town
          </h1>
          <div className="flex items-center justify-center gap-3">
            <div className="h-px w-12 bg-brown-500/50" />
            <h2 className="text-lg sm:text-xl font-display text-brown-300 tracking-widest uppercase">
              Mafia: Social Deduction
            </h2>
            <div className="h-px w-12 bg-brown-500/50" />
          </div>
        </div>

        {/* Game Description */}
        <div className="box p-4 space-y-3">
          <p className="text-brown-200 text-sm leading-relaxed">
            Welcome to <strong>Eliza Town</strong>, where AI agents play a game
            of <strong>Mafia</strong> — the classic social deduction game.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="bg-brown-800/50 p-3 rounded">
              <div className="font-display text-brown-300 mb-1">The Mafia</div>
              <p className="text-brown-200/80">
                Hidden killers who eliminate one citizen each night. They must
                blend in during the day and avoid suspicion.
              </p>
            </div>
            <div className="bg-brown-800/50 p-3 rounded">
              <div className="font-display text-brown-300 mb-1">
                The Citizens
              </div>
              <p className="text-brown-200/80">
                Innocent townspeople trying to identify and vote out the mafia
                before it's too late.
              </p>
            </div>
            <div className="bg-brown-800/50 p-3 rounded">
              <div className="font-display text-brown-300 mb-1">
                The Sheriff
              </div>
              <p className="text-brown-200/80">
                Can investigate one player each night to learn if they're mafia
                or innocent.
              </p>
            </div>
            <div className="bg-brown-800/50 p-3 rounded">
              <div className="font-display text-brown-300 mb-1">The Doctor</div>
              <p className="text-brown-200/80">
                Can protect one player each night from the mafia's attack.
              </p>
            </div>
          </div>
          <p className="text-brown-200/70 text-xs">
            Watch as 8 AI agents navigate accusations, form alliances, and try
            to survive the night. Will the town prevail, or will the mafia take
            over?
          </p>
        </div>

        {/* Settings */}
        <div className="box">
          <button
            type="button"
            className="w-full bg-brown-700 p-3 text-left font-display text-lg tracking-wider shadow-solid flex items-center justify-between cursor-pointer"
            onClick={() => setShowSettings(!showSettings)}
          >
            <span>AI Configuration</span>
            <span className="text-sm">{showSettings ? "▼" : "▶"}</span>
          </button>
          {showSettings && (
            <div className="p-4 space-y-3">
              <p className="text-brown-200/80 text-xs">
                The agents need an AI model to think and act. Choose a provider
                and add your API key. Keys are stored locally in your browser.
              </p>
              <ModelSettingsPanel />
              {!providerReady && (
                <p className="text-brown-300 text-xs bg-brown-800/50 p-2 rounded">
                  {settings.provider === "local"
                    ? "⚠️ Local AI doesn't work in browsers. Please select a cloud provider."
                    : "⚠️ Add your API key to enable the agents."}
                </p>
              )}
              {providerReady && (
                <p className="text-green-400 text-xs bg-green-900/30 p-2 rounded">
                  ✓ Provider configured! You're ready to enter the town.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Enter Button */}
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            className="button text-white shadow-solid text-xl cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onEnter}
            disabled={!providerReady}
          >
            <div className="h-full bg-clay-700 text-center px-8 py-3 font-display tracking-wider">
              Enter Town
            </div>
          </button>
          {!providerReady && (
            <p className="text-brown-300/70 text-xs">
              Configure your AI provider above to enter
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="text-center text-brown-200/50 text-xs space-y-1">
          <p>
            Powered by{" "}
            <a
              href="https://elizaos.github.io/eliza/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-brown-200"
            >
              elizaOS
            </a>
          </p>
          <p>The simulation runs entirely in your browser.</p>
        </div>
      </div>
    </div>
  );
}
