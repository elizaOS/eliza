"use client";

import { ToastStack } from "./ToastStack";

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <ToastStack />
    </>
  );
}
