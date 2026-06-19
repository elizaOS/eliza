import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DocumentMetaManager } from "./components/DocumentMetaManager";
import { I18nProvider } from "./providers/I18nProvider";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <DocumentMetaManager />
      <App />
    </I18nProvider>
  </StrictMode>,
);
