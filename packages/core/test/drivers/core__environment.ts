// SPEC.md, "Conformance": spec/core/environment.md against Environment of src/utils/environment.vibe, one per key over process variables of its own, observed through what each read returns
import type { Driver, Options } from "../../gen/core__environment.conformance.ts";
import type { EnvObservation, EnvValue } from "../../gen/core__environment.ts";
import { Environment } from "../../src/utils/environment.vibe";

const environments = new Map<string, Environment>();
const outputs = new Map<string, EnvObservation[]>();
const written = new Set<string>();
let run = 0;

const variable = (key: string, name: string): string =>
  `CORE_ENV_DRIVER_${process.pid}_${run}_${Buffer.from(key).toString("hex")}_${Buffer.from(name).toString("hex")}`;

const environmentOf = (key: string): Environment => {
  const existing = environments.get(key);
  if (existing) return existing;
  const created = new Environment();
  environments.set(key, created);
  return created;
};

const valueOf = (text: string | undefined): EnvValue =>
  text === undefined ? { tag: "AbsentValue" } : { tag: "PresentValue", text };

export const driver: Driver<null> = {
  reset: () => {
    for (const name of written) delete process.env[name];
    written.clear();
    environments.clear();
    outputs.clear();
    run += 1;
  },
  dispatch: (key, event) => {
    const environment = environmentOf(key);
    outputs.set(key, []);
    if (event.type === "setEnvironment") {
      const name = variable(key, event.key);
      written.add(name);
      environment.set(name, event.text);
    } else if (event.type === "externalEnvironmentChange") {
      const name = variable(key, event.key);
      written.add(name);
      if (event.value.tag === "AbsentValue") delete process.env[name];
      else process.env[name] = event.value.text;
    } else if (event.type === "clearEnvironmentCache") {
      environment.clearCache();
    } else {
      const fallback = event.defaultValue.tag === "AbsentValue" ? undefined : event.defaultValue.text;
      const value = valueOf(environment.get(variable(key, event.key), fallback));
      outputs.set(key, [{ tag: "ReadValue", key: event.key, value }]);
    }
    return "accepted";
  },
  observe: () => null,
  observeOutput: (key) => outputs.get(key) ?? [],
};

export const options: Options<null> = { view: () => null };
