// spec/client.md, "Story: Edit the list in the browser"; spec/client.md, "Story: Hear back from the server"
// .claude/skills/shell/SKILL.md, "The React interface": the page's one Tab of sync.vibe, as what TodoPage takes.
import { Effect, ManagedRuntime, Stream } from "effect";
import { useEffect, useState } from "react";
import { type Client, initial } from "../../gen/client.ts";
import type { TodoPageProps } from "./components/TodoPage.tsx";
import { Tab, browser, newId } from "./sync.vibe";

const name = crypto.getRandomValues(new Uint32Array(4)).join("-");
const runtime = ManagedRuntime.make(browser(location.origin, name));
/** Start one of the tab's effects. */
const run = (use: (tab: Tab.Shape) => Effect.Effect<unknown, unknown>) => runtime.runFork(Effect.flatMap(Effect.service(Tab), use));

/** Every state the tab publishes, and the tab's effects for what the user does. */
export function useTab(): TodoPageProps {
  const [client, setClient] = useState<Client>(initial);
  useEffect(() => {
    const open = [run((tab) => Stream.runForEach(tab.changes, (next) => Effect.sync(() => setClient(next)))), run((tab) => tab.listen())];
    return () => open.forEach((fiber) => fiber.interruptUnsafe());
  }, []);
  return {
    client,
    id: newId(name, client),
    onEdit: (edit) => run((tab) => tab.edit(edit)),
    onOnline: (online) => run((tab) => (online ? tab.goOnline() : tab.dispatch({ type: "goOffline" }))),
  };
}
