import {
  DashboardEndpointPending,
  DashboardErrorState,
  DashboardLoadingState,
} from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useCreditsBalance } from "../../lib/data/credits";
import { useVoices } from "../../lib/data/voices";
import { VoicePageClient } from "./_components/voice-page-client";

export default function VoicesPage() {
  const { ready, authenticated } = useRequireAuth();
  const voicesQuery = useVoices();
  const creditsQuery = useCreditsBalance();

  if (!ready || !authenticated) return <DashboardLoadingState label="Loading Voice Studio" />;

  return (
    <>
      <Helmet>
        <title>Voice Studio</title>
        <meta
          name="description"
          content="Clone your voice and create custom AI voices for text-to-speech"
        />
      </Helmet>
      {voicesQuery.isLoading || creditsQuery.isLoading ? (
        <DashboardLoadingState label="Loading Voice Studio" />
      ) : voicesQuery.isError ? (
        <DashboardErrorState
          message={(voicesQuery.error as Error)?.message ?? "Failed to load voices"}
        />
      ) : !voicesQuery.data ? (
        <DashboardEndpointPending endpoint="GET /api/v1/voice/list" what="Voice Studio" />
      ) : (
        <VoicePageClient
          initialVoices={voicesQuery.data}
          creditBalance={Number(creditsQuery.data?.balance ?? 0)}
        />
      )}
    </>
  );
}
