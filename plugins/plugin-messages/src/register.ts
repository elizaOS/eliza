import { isElizaOS } from "@elizaos/ui";
import { registerMessagesApp } from "./components/messages-app";

if (isElizaOS()) {
  registerMessagesApp();
}
