import React from "react";
import ReactDOM from "react-dom/client";
import "./pixi/extendPixi";
import Home from "./App.tsx";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Home />
  </React.StrictMode>,
);
