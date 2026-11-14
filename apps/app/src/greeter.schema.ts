// What the store holds of a greeter (greeter.vibe). The rules are not in it: `decodeState` checks them on the way in.
import { Schema } from "effect";

export const Saved = Schema.Struct({ name: Schema.String, count: Schema.Int });
