//@ backend dafny
// spec/app/index.md, "Once someone has been greeted, the greeter holds a name"
import type { Greeter } from "../gen/app.ts";

/** What the page says: an invitation until someone is greeted, then a greeting for the last name. */
export function greeting(g: Greeter): string {
  //@ requires inv(g)
  //@ ensures \result !== "Hello, !"
  if (g.count > 0) return "Hello, " + g.name + "!";
  return "Who should I greet?";
}
