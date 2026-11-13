// spec/client.md, "Story: Edit the list in the browser"; spec/client.md, "Story: Hear back from the server"
import { Effect, ManagedRuntime } from "effect";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useMachine } from "../../gen/client.react.ts";
import { initial } from "../../gen/client.ts";
import { TodoPage } from "./components/TodoPage.tsx";
import "./index.css";
import { Tab, browser, newId } from "./sync.vibe";

const name = crypto.getRandomValues(new Uint32Array(4)).join("-");
const runtime = ManagedRuntime.make(browser(location.origin, name));
/** Start one of the tab's effects. */
const run = (use: (tab: Tab.Shape) => Effect.Effect<unknown, unknown>) => runtime.runFork(Effect.flatMap(Effect.service(Tab), use));

/** The page over the tab's client Machine: every state it publishes, and the tab's effects for what the user does. */
function App() {
  const { state: client = initial, send } = useMachine(runtime);
  useEffect(() => {
    const listening = run((tab) => tab.listen());
    return () => listening.interruptUnsafe();
  }, []);
  return <TodoPage client={client} id={newId(name, client)} onEdit={(op) => run((tab) => tab.edit(op))} onOnline={(online) => (online ? run((tab) => tab.goOnline()) : send({ type: "goOffline" }))} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
