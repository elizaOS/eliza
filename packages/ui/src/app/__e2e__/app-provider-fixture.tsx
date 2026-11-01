/** Actual common provider; the runner supplies the existing canonical HTTP fixture. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { configureHostTransport } from "../../api/host-transport";
import { androidNativeAgentTransportForUrl, installAndroidNativeAgentFetchBridge, getAndroidLocalAgentBootStateForUrl, requestAndroidLocalAgentStartForUrl } from "../../api/android-native-agent-transport";
import { setBootConfig } from "../../config/boot-config-store";
import { useAppRuntimeSession } from "../runtime-session";
import { useAuthStatus } from "../../hooks/useAuthStatus";
import { createBrowserStartupHost } from "../../startup/browser-host";
import { useApp } from "../../state/useApp";
import { AppProvider } from "../AppProvider";

const nativeMode = Capacitor.isNativePlatform();
if (nativeMode) {
  setBootConfig({ apiBase: "eliza-local-agent://ipc", branding: {} });
  configureHostTransport(url => androidNativeAgentTransportForUrl(url));
  installAndroidNativeAgentFetchBridge();
}
const unexpectedNative = async () => { throw new Error("Web fixture invoked a native lifecycle method"); };
const startupHost = createBrowserStartupHost({
  native: {
    requestAndroidLocalAgentStartForUrl: nativeMode ? requestAndroidLocalAgentStartForUrl : async () => false,
    getAndroidLocalAgentBootStateForUrl: nativeMode ? getAndroidLocalAgentBootStateForUrl : unexpectedNative,
    appendIosBootTrace: () => {},
    isIosInProcessLocalAgentBase: () => false,
    isIosNativeAgentBootInProgress: () => false,
    isTerminalIosNativeAgentBootErrorMessage: () => false,
  },
  executeRuntimeManagementCommand: unexpectedNative,
});
// Browser URLs never select Android; the existing poll intentionally asks its
// host for every target and a non-native target is explicitly not applicable.
function Probe() {
  const app = useApp();
  const runtime = useAppRuntimeSession();
  const {state:auth} = useAuthStatus({skip:!app.startupCoordinator.isShellPaintable});
  const [updates,setUpdates] = useState(0);
  useEffect(() => {
    Object.assign(window,{providerProbe:{phase:app.startupCoordinator.phase,connected:app.connected,auth:auth.phase,commandQuery:app.commandQuery,runtime:runtime.status}});
  },[app.startupCoordinator.phase,app.connected,auth.phase,app.commandQuery,runtime.status]);
  return <main><h1>Common AppProvider fixture</h1><p>Controlled canonical HTTP API; no native effects or live authentication.</p><output data-testid="phase">{app.startupCoordinator.phase}</output><output data-testid="auth">{auth.phase}</output><button onClick={()=>{app.setState("commandQuery",String(updates+1));setUpdates(value=>value+1);}}>Unrelated render {updates}</button><button onClick={app.retryStartup}>Retry startup</button></main>;
}
createRoot(document.getElementById("root")!).render(<AppProvider startupHost={startupHost}><Probe/></AppProvider>);
