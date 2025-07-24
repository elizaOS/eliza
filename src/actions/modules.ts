import { ActionModule } from "./types";
import * as strategy from "./strategy";
import * as swap from "./swap";
import * as wallet from "./wallet";

export const modules: ActionModule[] = [
  strategy,
  swap,
  wallet,
];
