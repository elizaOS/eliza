// The page's entry: the studio, drawn into index.html.
import { createRoot } from "react-dom/client";
import "virtual:studio-theme.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("app")!).render(<App />);
