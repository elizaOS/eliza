/** Actual shared surface; native answers are controlled, never live authentication. */
import { createRoot } from "react-dom/client";
import type { NativeCloudSignInPort } from "@elizaos/auth/auth/native-cloud-sign-in";
import { createTranslator } from "../../i18n/index";
import { NativeCloudSignInView } from "../NativeCloudSignInView";
import { NativeCloudSignInController } from "../native-cloud-sign-in-controller";

const attemptId = "6f1c2c63-6d7a-4bd6-9b6c-1f2d3e4a5b6c";
const stats = { cancelled: 0, verified: 0, activated: 0, underlyingClicks: 0 };
Object.assign(window, { signInFixtureStats: stats });
const port: NativeCloudSignInPort<"production"> = {
  status: async () => ({ inApp: true, methodsKnown: true, google: true, email: true, phone: true }),
  startGoogle: () => new Promise(() => {}),
  startEmail: async () => ({ attemptId, expiresAt: Date.now()+600_000, resendAt: Date.now()+60_000 }),
  verifyEmail: async () => {
    if (++stats.verified === 1) throw { code: "invalid-code" };
    return { status: "mfa", attemptId, method: "totp", expiresAt: Date.now()+600_000 };
  },
  verifyMfa: async () => ({ status: "authenticated", environment: "production", expiresAt: Date.now()+60_000, accountCreated: false }),
  cancel: async () => { stats.cancelled++; },
};
const controller = new NativeCloudSignInController(port, {
  environment: "production", current: () => true, abandoned: () => {},
  activate: async () => { if (++stats.activated === 1) throw new Error("controlled readback unavailable"); },
});
controller.start();
const embedded = new URLSearchParams(location.search).has("embedded");
createRoot(document.getElementById("root")!).render(<>
  <section style={{background:"#cc1466",color:"white",minHeight:"100vh",padding:"1rem"}}>
    <h2>Live shell behind sign-in</h2><p>Controlled native fixture · no real authentication</p>
    <button onClick={() => stats.underlyingClicks++}>Underlying shell action</button>
    {embedded && <NativeCloudSignInView controller={controller} embedded copy={{serviceName:"Eliza Cloud",productName:"Eliza"}} translate={createTranslator("en")} />}
  </section>
  {!embedded && <NativeCloudSignInView controller={controller} copy={{serviceName:"Eliza Cloud",productName:"Eliza"}} translate={createTranslator("en")} />}
</>);
