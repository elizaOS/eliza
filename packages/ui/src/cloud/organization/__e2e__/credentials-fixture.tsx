/**
 * Browser fixture for the org credentials-tab visual e2e (#11332 / #11488).
 * Mounts the REAL CredentialsTab — CloudI18nProvider + react-query + the real
 * sonner <Toaster/> — against the live mock cloud stack proxied on the page
 * origin. The host page seeds the steward token in localStorage; the fixture
 * fetches the real /api/v1/user for the RBAC-bearing user DTO exactly like the
 * dashboard shell does. `?contribute=1` mirrors the connect-link landing
 * (auto-open contribute modal).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { api } from "../../lib/api-client";
import { CloudI18nProvider } from "../../shell/CloudI18nProvider";
import { CredentialsTab } from "../credentials-tab";
import type { UserWithOrganizationDto } from "../data/cloud-org-types";

interface Envelope<T> {
  data: T;
}

function Fixture() {
  const [user, setUser] = useState<UserWithOrganizationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoContribute = new URLSearchParams(window.location.search).has(
    "contribute",
  );

  useEffect(() => {
    api<Envelope<UserWithOrganizationDto>>("/api/v1/user")
      .then((res) => setUser(res.data))
      .catch((err) => setError(String(err)));
  }, []);

  if (error) return <div data-testid="fixture-error">{error}</div>;
  if (!user) return <div data-testid="fixture-loading">loading user…</div>;
  return (
    <div className="min-h-screen bg-bg font-body text-txt">
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <CredentialsTab user={user} autoContribute={autoContribute} />
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("fixture root missing");
createRoot(rootEl).render(
  <CloudI18nProvider initialLang="en">
    <QueryClientProvider client={queryClient}>
      <Fixture />
    </QueryClientProvider>
  </CloudI18nProvider>,
);
