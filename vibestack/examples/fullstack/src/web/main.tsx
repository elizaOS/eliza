// spec/client.md, "Story: Edit the list in the browser"; spec/client.md, "Story: Hear back from the server"
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TodoPage } from "./components/TodoPage.tsx";
import "./index.css";
import { useTab } from "./useTab.ts";

function App() {
  return <TodoPage {...useTab()} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
