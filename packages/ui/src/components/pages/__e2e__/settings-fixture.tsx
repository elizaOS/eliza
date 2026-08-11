/**
 * Self-contained Settings browser fixture over the real section registry.
 * State, API, and core boundaries are stubbed, while production providers and
 * section components stay mounted so navigation and visible failure states are
 * exercised by the walkthrough.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { TranslationProvider } from "../../../state/TranslationProvider";
import { SettingsView } from "../SettingsView";

function Harness(): React.JSX.Element {
  return (
    <TranslationProvider>
      <div className="min-h-screen w-full bg-bg text-txt">
        <SettingsView />
      </div>
    </TranslationProvider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
