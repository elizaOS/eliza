import { isAuthEnabled } from "@/lib/auth-mode";
import { isDevLoginEnabled } from "@/lib/env";
import LoginClient from "./LoginClient";

export default function LoginPage() {
  return (
    <LoginClient
      authEnabled={isAuthEnabled()}
      devLoginEnabled={isDevLoginEnabled()}
    />
  );
}
