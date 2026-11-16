import { Layer, ManagedRuntime } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { greeter } from "./greeter.vibe";
import "./main.css";

const runtime = ManagedRuntime.make(Layer.provide(greeter, KeyValueStore.layerStorage(() => localStorage)));

createRoot(document.getElementById("root")!).render(<StrictMode><App runtime={runtime} search={location.search} /></StrictMode>);
