/** Canonical application adapter for the shared native sign-in controller and view. */

import type { NativeCloudSignInError } from "@elizaos/auth/auth/native-cloud-sign-in";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { useAppSelector } from "../state/app-store";
import { NativeCloudSignInView } from "./NativeCloudSignInView";
import {
  type AndroidNativeCloudSignInRequest,
  abandonAndroidNativeCloudSignIn,
  activateAndroidNativeCloudSignIn,
  androidNativeCloudSignInPort,
  ELIZA_NATIVE_CLOUD_SIGN_IN_COPY,
  type ElizaNativeCloudSignInPort,
  getAndroidNativeCloudSignInRequest,
  subscribeAndroidNativeCloudSignInRequest,
  subscribeAndroidNativeCloudSignInReturn,
} from "./native-cloud-sign-in";
import { NativeCloudSignInController } from "./native-cloud-sign-in-controller";
export interface AndroidNativeCloudSignInViewProps {
  request: AndroidNativeCloudSignInRequest;
  port?: ElizaNativeCloudSignInPort;
  onAuthenticated?: (outcome: unknown) => Promise<void> | void;
  onAbandon?: (error: NativeCloudSignInError) => void;
}
export function AndroidNativeCloudSignInView({
  request,
  port: portOverride,
  onAuthenticated,
  onAbandon,
}: AndroidNativeCloudSignInViewProps) {
  const port = portOverride ?? request.port ?? androidNativeCloudSignInPort();
  const t = useAppSelector((state) => state.t);
  const latest = useRef({ request, onAuthenticated, onAbandon });
  latest.current = { request, onAuthenticated, onAbandon };
  const serviceLoader = useMemo(() => {
    const serviceInfo = port.serviceInfo?.bind(port);
    return serviceInfo
      ? (environment: typeof request.environment) =>
          serviceInfo({ environment })
      : undefined;
  }, [port]);
  const controller = useMemo(
    () =>
      new NativeCloudSignInController(port, {
        environment: request.environment,
        current: () =>
          latest.current.request.id === request.id &&
          latest.current.request.environment === request.environment,
        activate: (outcome, signal) => {
          if (latest.current.onAuthenticated)
            return latest.current.onAuthenticated(outcome);
          else
            return activateAndroidNativeCloudSignIn(
              request.id,
              outcome,
              signal,
            );
        },
        abandoned: (error) => {
          if (latest.current.onAbandon) latest.current.onAbandon(error);
          else abandonAndroidNativeCloudSignIn(request.id, error);
        },
      }),
    [request.id, request.environment, port],
  );
  useEffect(() => {
    controller.start();
    const unsubscribe = subscribeAndroidNativeCloudSignInReturn(
      request.id,
      (outcome) => {
        void controller.acceptReturn(outcome);
      },
    );
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller, request.id]);
  return (
    <NativeCloudSignInView
      controller={controller}
      copy={request.copy ?? ELIZA_NATIVE_CLOUD_SIGN_IN_COPY}
      serviceLoader={serviceLoader}
      translate={(key, options) => t(key, options)}
    />
  );
}
export function AndroidNativeCloudSignInHost({
  fallback = null,
  port,
}: {
  fallback?: ReactNode;
  port?: ElizaNativeCloudSignInPort;
}) {
  const request = useSyncExternalStore(
    subscribeAndroidNativeCloudSignInRequest,
    getAndroidNativeCloudSignInRequest,
    getAndroidNativeCloudSignInRequest,
  );
  return request ? (
    <AndroidNativeCloudSignInView
      key={request.id}
      request={request}
      port={port}
    />
  ) : (
    fallback
  );
}
