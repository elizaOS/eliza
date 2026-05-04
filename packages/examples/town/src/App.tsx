import { useEffect, useState } from "react";
import ReactModal, { type Styles } from "react-modal";
import Game from "./components/Game.tsx";
import ModelSettingsPanel from "./components/ModelSettings";
import SplashPage from "./components/SplashPage.tsx";
import { useModelSettings } from "./hooks/useModelSettings";
import { useIsRunning } from "./hooks/useTownControls";
import { useTownState } from "./hooks/useTownState";
import { isProviderConfigured } from "./runtime/modelSettings";

const ENTERED_KEY = "ai-town-entered";

function getHasEntered(): boolean {
  try {
    return localStorage.getItem(ENTERED_KEY) === "true";
  } catch {
    return false;
  }
}

function setHasEntered(value: boolean): void {
  try {
    if (value) {
      localStorage.setItem(ENTERED_KEY, "true");
    } else {
      localStorage.removeItem(ENTERED_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export default function Home() {
  const [hasEntered, setHasEnteredState] = useState(getHasEntered);
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsModalForcedOpen, setSettingsModalForcedOpen] = useState(false);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const isRunning = useIsRunning();
  const settings = useModelSettings();
  const providerReady = isProviderConfigured(settings);
  const townState = useTownState();

  const handleEnterTown = () => {
    setHasEntered(true);
    setHasEnteredState(true);
  };

  // Only force settings modal open if user has entered but provider isn't ready
  useEffect(() => {
    if (!hasEntered) {
      return;
    }
    if (!providerReady) {
      setSettingsModalOpen(true);
      setSettingsModalForcedOpen(true);
      return;
    }
    if (settingsModalForcedOpen) {
      setSettingsModalOpen(false);
      setSettingsModalForcedOpen(false);
    }
  }, [hasEntered, providerReady, settingsModalForcedOpen]);

  const closeSettings = () => {
    if (!providerReady) {
      return;
    }
    setSettingsModalOpen(false);
  };

  // Show splash page if user hasn't entered yet
  if (!hasEntered) {
    return <SplashPage settings={settings} onEnter={handleEnterTown} />;
  }
  return (
    <main className="relative flex min-h-screen w-full flex-col font-body game-background">
      <ReactModal
        isOpen={helpModalOpen}
        onRequestClose={() => setHelpModalOpen(false)}
        style={modalStyles}
        contentLabel="Help modal"
        ariaHideApp={false}
      >
        <div className="font-body">
          <h1 className="text-center text-6xl font-bold font-display game-title">
            Help
          </h1>
          <p>
            Welcome to Eliza Town. Eliza agents wander the map, notice nearby
            neighbors, and start conversations on their own.
          </p>
          <h2 className="text-4xl mt-4">Viewing the town</h2>
          <p className="mt-4">
            Click and drag to move around the town, and scroll to zoom. Click a
            character to view their latest messages.
          </p>
          <h2 className="text-4xl mt-4">Simulation</h2>
          <p className="mt-4">
            The town runs entirely in your browser. Each agent receives a short
            world update, picks an action like moving or chatting, and speaks
            using an elizaOS runtime.
          </p>
        </div>
      </ReactModal>

      <ReactModal
        isOpen={settingsModalOpen}
        onRequestClose={closeSettings}
        style={settingsModalStyles}
        contentLabel="Agent settings"
        ariaHideApp={false}
        shouldCloseOnOverlayClick={providerReady}
        shouldCloseOnEsc={providerReady}
      >
        <div className="font-body space-y-4">
          <h1 className="text-center text-4xl font-bold font-display game-title">
            Settings
          </h1>
          {!providerReady && (
            <p className="text-sm opacity-80">
              Choose a model provider and add the required API key to play.
            </p>
          )}
          <ModelSettingsPanel />
        </div>
      </ReactModal>

      <ReactModal
        isOpen={logModalOpen}
        onRequestClose={() => setLogModalOpen(false)}
        style={logModalStyles}
        contentLabel="Conversation log"
        ariaHideApp={false}
      >
        <div className="font-body space-y-4 text-brown-900">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-3xl font-bold font-display">
              Conversation Log
            </h1>
            <button
              type="button"
              className="button text-brown-900 shadow-solid text-sm cursor-pointer"
              onClick={() => setLogModalOpen(false)}
            >
              <div className="h-full bg-white/80 text-center px-3 py-1">
                Close
              </div>
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto space-y-2 pr-2">
            {townState?.messages.length ? (
              townState.messages.map((message) => (
                <div key={message.id} className="text-sm">
                  <span className="opacity-70">
                    {formatTimestamp(message.createdAt)}
                  </span>{" "}
                  <span className="font-semibold">{message.authorName}:</span>{" "}
                  {message.text}
                </div>
              ))
            ) : (
              <div className="text-sm opacity-70">No messages yet.</div>
            )}
          </div>
        </div>
      </ReactModal>

      <div className="w-full h-screen min-h-screen relative isolate overflow-hidden flex flex-col justify-start">
        <button
          type="button"
          className="button text-white shadow-solid text-sm cursor-pointer pointer-events-auto absolute top-4 left-4 lg:hidden"
          onClick={() => {
            setSettingsModalOpen(true);
            setSettingsModalForcedOpen(false);
          }}
        >
          <div className="h-full bg-clay-700 text-center px-3 py-2">☰</div>
        </button>
        <Game
          onOpenSettings={() => {
            setSettingsModalOpen(true);
            setSettingsModalForcedOpen(false);
          }}
          isRunning={isRunning}
          canRun={providerReady}
        />

        <button
          type="button"
          className="button text-brown-900 shadow-solid text-sm cursor-pointer pointer-events-auto absolute bottom-6 left-6"
          onClick={() => setLogModalOpen(true)}
        >
          <div className="h-full bg-white/80 text-center px-4 py-2">
            Conversation Log
          </div>
        </button>
      </div>
    </main>
  );
}

const modalStyles: Styles = {
  overlay: {
    backgroundColor: "rgb(0, 0, 0, 75%)",
    zIndex: 12,
  },
  content: {
    top: "50%",
    left: "50%",
    right: "auto",
    bottom: "auto",
    marginRight: "-50%",
    transform: "translate(-50%, -50%)",
    maxWidth: "50%",

    border: "10px solid rgb(23, 20, 33)",
    borderRadius: "0",
    background: "rgb(35, 38, 58)",
    color: "white",
    fontFamily: '"Upheaval Pro", "sans-serif"',
  },
};

const settingsModalStyles: Styles = {
  overlay: {
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    zIndex: 12,
  },
  content: {
    top: "50%",
    left: "50%",
    right: "auto",
    bottom: "auto",
    marginRight: "-50%",
    transform: "translate(-50%, -50%)",
    maxWidth: "720px",
    width: "92vw",
    maxHeight: "85vh",
    border: "8px solid rgb(23, 20, 33)",
    borderRadius: "0",
    background: "rgb(35, 38, 58)",
    color: "white",
    fontFamily: '"Upheaval Pro", "sans-serif"',
    overflowY: "auto",
    padding: "24px",
  },
};

const logModalStyles: Styles = {
  overlay: {
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    zIndex: 12,
  },
  content: {
    top: "50%",
    left: "50%",
    right: "auto",
    bottom: "auto",
    marginRight: "-50%",
    transform: "translate(-50%, -50%)",
    maxWidth: "900px",
    width: "90vw",
    maxHeight: "80vh",
    border: "6px solid rgba(35, 38, 58, 0.7)",
    borderRadius: "0",
    background: "rgba(255, 255, 255, 0.8)",
    color: "rgb(30, 30, 30)",
    fontFamily: '"Upheaval Pro", "sans-serif"',
  },
};

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
